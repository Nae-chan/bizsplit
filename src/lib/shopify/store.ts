import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { shopifyOrder, shopifyOrderLine, storeConnection, syncJob } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { exchangeClientCredentials, shopifyGraphql } from "@/lib/shopify/client";
import { ORDERS_PAGE_QUERY, SHOP_QUERY } from "@/lib/shopify/queries";
import { mapOrderNode, type MappedOrder, type ShopifyOrderNode } from "@/lib/shopify/mapping";

const PAGE_SIZE = 50;

export async function getConnectionForUser(userId: string) {
  const rows = await db
    .select()
    .from(storeConnection)
    .where(and(eq(storeConnection.userId, userId), eq(storeConnection.status, "active")))
    .limit(1);
  return rows[0] ?? null;
}

interface ShopInfo {
  shop: {
    name: string;
    myshopifyDomain: string;
    currencyCode: string;
    ianaTimezone?: string | null;
  };
}

export async function createConnection(opts: {
  userId: string;
  shopDomain: string;
  clientId: string;
  clientSecret: string;
}) {
  // The exchange doubles as validation: it fails unless the credentials are
  // right and the app is installed on the store.
  const token = await exchangeClientCredentials(opts.shopDomain, opts.clientId, opts.clientSecret);
  const shopInfo = await shopifyGraphql<ShopInfo>(opts.shopDomain, token.accessToken, SHOP_QUERY);

  const id = randomUUID();
  await db.insert(storeConnection).values({
    id,
    userId: opts.userId,
    shopDomain: shopInfo.shop.myshopifyDomain,
    shopName: shopInfo.shop.name,
    currency: shopInfo.shop.currencyCode,
    ianaTimezone: shopInfo.shop.ianaTimezone ?? null,
    encryptedClientId: encryptSecret(opts.clientId),
    encryptedClientSecret: encryptSecret(opts.clientSecret),
    encryptedAccessToken: encryptSecret(token.accessToken),
    tokenExpiresAt: token.expiresAt,
  });
  return {
    id,
    shopName: shopInfo.shop.name,
    currency: shopInfo.shop.currencyCode,
    accessToken: token.accessToken,
  };
}

const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Return a valid access token for the connection, re-exchanging the client
 * credentials when the cached token is missing or within 5 minutes of expiry.
 */
export async function getAccessToken(conn: typeof storeConnection.$inferSelect): Promise<string> {
  if (
    conn.encryptedAccessToken &&
    conn.tokenExpiresAt &&
    conn.tokenExpiresAt.getTime() - Date.now() > TOKEN_REFRESH_MARGIN_MS
  ) {
    return decryptSecret(conn.encryptedAccessToken);
  }
  const fresh = await exchangeClientCredentials(
    conn.shopDomain,
    decryptSecret(conn.encryptedClientId),
    decryptSecret(conn.encryptedClientSecret),
  );
  await db
    .update(storeConnection)
    .set({
      encryptedAccessToken: encryptSecret(fresh.accessToken),
      tokenExpiresAt: fresh.expiresAt,
      updatedAt: sql`now()`,
    })
    .where(eq(storeConnection.id, conn.id));
  return fresh.accessToken;
}

/**
 * Refresh the shop's IANA timezone on the connection. Effective-dated costs are
 * entered as shop-local dates, so the zone has to stay current.
 */
export async function refreshShopTimezone(
  conn: typeof storeConnection.$inferSelect,
  token: string,
): Promise<string | null> {
  const shopInfo = await shopifyGraphql<ShopInfo>(conn.shopDomain, token, SHOP_QUERY);
  const zone = shopInfo.shop.ianaTimezone ?? null;
  if (zone !== conn.ianaTimezone) {
    await db
      .update(storeConnection)
      .set({ ianaTimezone: zone, updatedAt: sql`now()` })
      .where(eq(storeConnection.id, conn.id));
  }
  return zone;
}

export async function upsertMappedOrder(connectionId: string, mapped: MappedOrder) {
  await db
    .insert(shopifyOrder)
    .values({ ...mapped.order, connectionId })
    .onConflictDoUpdate({
      target: shopifyOrder.id,
      set: {
        subtotalCents: mapped.order.subtotalCents,
        discountsCents: mapped.order.discountsCents,
        shippingCents: mapped.order.shippingCents,
        taxCents: mapped.order.taxCents,
        totalCents: mapped.order.totalCents,
        feesCents: mapped.order.feesCents,
        financialStatus: mapped.order.financialStatus,
        shopifyUpdatedAt: mapped.order.shopifyUpdatedAt,
        syncedAt: sql`now()`,
      },
    });
  for (const line of mapped.lines) {
    await db
      .insert(shopifyOrderLine)
      .values({ ...line, orderId: mapped.order.id })
      .onConflictDoUpdate({
        target: shopifyOrderLine.id,
        set: {
          quantity: line.quantity,
          unitPriceCents: line.unitPriceCents,
          discountedTotalCents: line.discountedTotalCents,
        },
      });
  }
}

/**
 * Load a job for one step, putting a failed job back into `running` first. The
 * cursor and counter are left alone, so retrying a failed job resumes from the
 * page that failed instead of restarting the sync and losing its progress.
 */
export async function claimSyncJob(jobId: string) {
  const [job] = await db.select().from(syncJob).where(eq(syncJob.id, jobId)).limit(1);
  if (!job) throw new Error("Sync job not found");
  if (job.status !== "failed") return job;
  const [resumed] = await db
    .update(syncJob)
    .set({ status: "running", error: null, updatedAt: sql`now()` })
    .where(eq(syncJob.id, jobId))
    .returning();
  return resumed;
}

/** Record a step failure on the job. The cursor is kept so a retry can resume. */
export async function failSyncJob(jobId: string, error: string) {
  const [updated] = await db
    .update(syncJob)
    .set({ status: "failed", error, updatedAt: sql`now()` })
    .where(eq(syncJob.id, jobId))
    .returning();
  return updated;
}

/**
 * A token exchange failure is a connection problem, not a sync problem, so it
 * carries its own remediation hint into syncJob.error (ADR-0006).
 */
export function tokenFailureMessage(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return `${message} Reconnect the store from Settings → Store connection to refresh its credentials.`;
}

/** Advance a backfill by one page. Returns updated progress. */
export async function runOrderSyncStep(jobId: string) {
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
    const data = await shopifyGraphql<{
      orders: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: ShopifyOrderNode[];
      };
    }>(conn.shopDomain, token, ORDERS_PAGE_QUERY, {
      first: PAGE_SIZE,
      after: job.cursor,
      query: job.startDate ? `created_at:>='${job.startDate.toISOString()}'` : undefined,
    });

    for (const node of data.orders.nodes) {
      await upsertMappedOrder(conn.id, mapOrderNode(node, conn.id));
    }

    const done = !data.orders.pageInfo.hasNextPage;
    const [updated] = await db
      .update(syncJob)
      .set({
        cursor: data.orders.pageInfo.endCursor,
        itemsSynced: job.itemsSynced + data.orders.nodes.length,
        status: done ? "completed" : "running",
        updatedAt: sql`now()`,
      })
      .where(eq(syncJob.id, jobId))
      .returning();
    return updated;
  } catch (err) {
    return failSyncJob(jobId, err instanceof Error ? err.message : String(err));
  }
}

export async function latestSyncJob(connectionId: string, kind: "orders" | "products" = "orders") {
  const rows = await db
    .select()
    .from(syncJob)
    .where(and(eq(syncJob.connectionId, connectionId), eq(syncJob.kind, kind)))
    .orderBy(desc(syncJob.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/** A sync job of any kind, scoped to the caller — the ownership check for /api/store/sync-step. */
export async function getSyncJobForUser(userId: string, jobId: string) {
  const rows = await db
    .select({ job: syncJob })
    .from(syncJob)
    .innerJoin(storeConnection, eq(syncJob.connectionId, storeConnection.id))
    .where(and(eq(syncJob.id, jobId), eq(storeConnection.userId, userId)))
    .limit(1);
  return rows[0]?.job ?? null;
}
