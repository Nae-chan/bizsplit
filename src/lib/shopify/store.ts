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

export async function createConnection(opts: {
  userId: string;
  shopDomain: string;
  clientId: string;
  clientSecret: string;
}) {
  // The exchange doubles as validation: it fails unless the credentials are
  // right and the app is installed on the store.
  const token = await exchangeClientCredentials(opts.shopDomain, opts.clientId, opts.clientSecret);
  const shopInfo = await shopifyGraphql<{
    shop: { name: string; myshopifyDomain: string; currencyCode: string };
  }>(opts.shopDomain, token.accessToken, SHOP_QUERY);

  const id = randomUUID();
  await db.insert(storeConnection).values({
    id,
    userId: opts.userId,
    shopDomain: shopInfo.shop.myshopifyDomain,
    shopName: shopInfo.shop.name,
    currency: shopInfo.shop.currencyCode,
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

/** Advance a backfill by one page. Returns updated progress. */
export async function runSyncStep(jobId: string) {
  const [job] = await db.select().from(syncJob).where(eq(syncJob.id, jobId)).limit(1);
  if (!job) throw new Error("Sync job not found");
  if (job.status !== "running") return job;

  const [conn] = await db
    .select()
    .from(storeConnection)
    .where(eq(storeConnection.id, job.connectionId))
    .limit(1);
  if (!conn) throw new Error("Connection not found");
  const token = await getAccessToken(conn);

  try {
    const data = await shopifyGraphql<{
      orders: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: ShopifyOrderNode[];
      };
    }>(conn.shopDomain, token, ORDERS_PAGE_QUERY, {
      first: PAGE_SIZE,
      after: job.cursor,
      query: `created_at:>='${job.startDate.toISOString()}'`,
    });

    for (const node of data.orders.nodes) {
      await upsertMappedOrder(conn.id, mapOrderNode(node, conn.id));
    }

    const done = !data.orders.pageInfo.hasNextPage;
    const [updated] = await db
      .update(syncJob)
      .set({
        cursor: data.orders.pageInfo.endCursor,
        ordersSynced: job.ordersSynced + data.orders.nodes.length,
        status: done ? "completed" : "running",
        updatedAt: sql`now()`,
      })
      .where(eq(syncJob.id, jobId))
      .returning();
    return updated;
  } catch (err) {
    const [updated] = await db
      .update(syncJob)
      .set({
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        updatedAt: sql`now()`,
      })
      .where(eq(syncJob.id, jobId))
      .returning();
    return updated;
  }
}

export async function latestSyncJob(connectionId: string) {
  const rows = await db
    .select()
    .from(syncJob)
    .where(eq(syncJob.connectionId, connectionId))
    .orderBy(desc(syncJob.createdAt))
    .limit(1);
  return rows[0] ?? null;
}
