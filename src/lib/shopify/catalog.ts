import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, notInArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { shopifyProduct, shopifyVariant, storeConnection, syncJob } from "@/db/schema";
import { shopifyGraphql, ShopifyApiError } from "@/lib/shopify/client";
import { PRODUCTS_PAGE_QUERY } from "@/lib/shopify/queries";
import { mapProductNode, type MappedProduct, type ShopifyProductNode } from "@/lib/shopify/mapping";
import {
  claimSyncJob,
  failSyncJob,
  getAccessToken,
  refreshShopTimezone,
  tokenFailureMessage,
} from "@/lib/shopify/store";

/**
 * Product catalog sync. Mirrors the order backfill in store.ts: one page per
 * HTTP request, cursor and counters in sync_job, no background worker.
 * Pages are smaller than the order backfill's because each product node
 * carries up to 100 nested variants.
 */
const PRODUCT_PAGE_SIZE = 25;

export async function upsertMappedProduct(connectionId: string, mapped: MappedProduct) {
  await db
    .insert(shopifyProduct)
    .values({ ...mapped.product, connectionId })
    .onConflictDoUpdate({
      target: shopifyProduct.id,
      set: {
        title: mapped.product.title,
        handle: mapped.product.handle,
        status: mapped.product.status,
        productType: mapped.product.productType,
        vendor: mapped.product.vendor,
        imageUrl: mapped.product.imageUrl,
        shopifyUpdatedAt: mapped.product.shopifyUpdatedAt,
        // A product that reappears upstream is no longer deleted.
        deletedAt: null,
        syncedAt: sql`now()`,
      },
    });
  for (const variant of mapped.variants) {
    await db
      .insert(shopifyVariant)
      .values({ ...variant, productId: mapped.product.id })
      .onConflictDoUpdate({
        target: shopifyVariant.id,
        set: {
          title: variant.title,
          sku: variant.sku,
          position: variant.position,
          priceCents: variant.priceCents,
          shopifyUpdatedAt: variant.shopifyUpdatedAt,
          deletedAt: null,
          syncedAt: sql`now()`,
        },
      });
  }
  if (mapped.hasMoreVariants) {
    // Deferred: per-product variant paging. Only the first 100 are synced.
    console.warn(`[catalog] ${mapped.product.id} has more than 100 variants — only 100 synced`);
  } else {
    // Variants missing from a complete payload were removed upstream: soft-delete
    // them so they leave the catalog while their cost history survives. Skipped
    // when the payload is partial — the unseen variants are not deleted ones.
    const present = mapped.variants.map((v) => v.id);
    await db
      .update(shopifyVariant)
      .set({ deletedAt: new Date(), syncedAt: sql`now()` })
      .where(
        and(
          eq(shopifyVariant.productId, mapped.product.id),
          isNull(shopifyVariant.deletedAt),
          present.length > 0 ? notInArray(shopifyVariant.id, present) : undefined,
        ),
      );
  }
}

/**
 * Soft-delete a product and its variants (products/delete webhook). Rows are
 * never removed: variant cost history hangs off variants, and past orders
 * reference variants of products the merchant has since deleted.
 */
export async function markProductDeleted(productId: string) {
  const deletedAt = new Date();
  await db
    .update(shopifyProduct)
    .set({ deletedAt, syncedAt: sql`now()` })
    .where(eq(shopifyProduct.id, productId));
  await db
    .update(shopifyVariant)
    .set({ deletedAt, syncedAt: sql`now()` })
    .where(eq(shopifyVariant.productId, productId));
}

/** Advance a catalog sync by one page of products. Returns updated progress. */
export async function runProductSyncStep(jobId: string) {
  const job = await claimSyncJob(jobId);
  if (job.status !== "running") return job;

  const [conn] = await db
    .select()
    .from(storeConnection)
    .where(eq(storeConnection.id, job.connectionId))
    .limit(1);
  if (!conn) throw new Error("Connection not found");

  let token: string;
  try {
    token = await getAccessToken(conn);
  } catch (err) {
    return failSyncJob(jobId, tokenFailureMessage(err));
  }

  try {
    // Effective dates are interpreted in the shop's timezone, so keep it current
    // — once per run, on the first page.
    if (job.cursor === null) await refreshShopTimezone(conn, token);

    const data = await shopifyGraphql<{
      products: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: ShopifyProductNode[];
      };
    }>(conn.shopDomain, token, PRODUCTS_PAGE_QUERY, {
      first: PRODUCT_PAGE_SIZE,
      after: job.cursor,
      query: job.startDate ? `updated_at:>='${job.startDate.toISOString()}'` : undefined,
    });

    for (const node of data.products.nodes) {
      await upsertMappedProduct(conn.id, mapProductNode(node));
    }

    const done = !data.products.pageInfo.hasNextPage;
    const [updated] = await db
      .update(syncJob)
      .set({
        cursor: data.products.pageInfo.endCursor,
        itemsSynced: job.itemsSynced + data.products.nodes.length,
        status: done ? "completed" : "running",
        updatedAt: sql`now()`,
      })
      .where(eq(syncJob.id, jobId))
      .returning();
    return updated;
  } catch (err) {
    return failSyncJob(jobId, catalogFailureMessage(err));
  }
}

/**
 * A connection without the read_products scope gets a 403 on its first catalog
 * page. Surface the remediation in syncJob.error, the way /api/store/connect
 * surfaces the credentials hint.
 */
function catalogFailureMessage(err: unknown) {
  if (err instanceof ShopifyApiError && err.status === 403) {
    return `${err.message} Reinstall the app on this store with product read access (read_products).`;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Start (or re-attach to) a catalog sync. `since` limits the sync to products
 * updated on or after that instant; omit it for a full catalog sync.
 */
export async function startCatalogSync(connectionId: string, since?: Date) {
  const [running] = await db
    .select()
    .from(syncJob)
    .where(
      and(
        eq(syncJob.connectionId, connectionId),
        eq(syncJob.kind, "products"),
        eq(syncJob.status, "running"),
      ),
    )
    .orderBy(desc(syncJob.createdAt))
    .limit(1);
  if (running) return running;

  const [created] = await db
    .insert(syncJob)
    .values({
      id: randomUUID(),
      connectionId,
      kind: "products",
      startDate: since ?? null,
    })
    .returning();
  return created;
}

/** The instant to resume an incremental catalog sync from, or undefined for a full sync. */
export async function lastCompletedCatalogSyncAt(connectionId: string) {
  const [row] = await db
    .select()
    .from(syncJob)
    .where(
      and(
        eq(syncJob.connectionId, connectionId),
        eq(syncJob.kind, "products"),
        eq(syncJob.status, "completed"),
      ),
    )
    .orderBy(desc(syncJob.createdAt))
    .limit(1);
  return row?.createdAt ?? undefined;
}
