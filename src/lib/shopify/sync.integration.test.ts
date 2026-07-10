import { beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as schema from "@/db/schema";

/**
 * End-to-end sync test: in-memory Postgres + mocked Shopify GraphQL API.
 * Exercises connection creation (token encryption), paged backfill via
 * runSyncStep, idempotent upserts, and the fee-pending state.
 */

const client = new PGlite();
const testDb = drizzle(client, { schema });

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

process.env.TOKEN_ENCRYPTION_KEY = "integration-test-key";

// Two pages of orders; second order has no fee data yet (fee-hold case).
function orderNode(n: number, feeAmount: string | null) {
  return {
    id: `gid://shopify/Order/${n}`,
    name: `#${n}`,
    createdAt: "2026-07-01T12:00:00Z",
    updatedAt: "2026-07-01T12:05:00Z",
    currencyCode: "USD",
    displayFinancialStatus: "PAID",
    subtotalPriceSet: { shopMoney: { amount: "20.00" } },
    totalDiscountsSet: { shopMoney: { amount: "0.00" } },
    totalShippingPriceSet: { shopMoney: { amount: "5.00" } },
    totalTaxSet: { shopMoney: { amount: "0.00" } },
    totalPriceSet: { shopMoney: { amount: "25.00" } },
    lineItems: {
      nodes: [
        {
          id: `gid://shopify/LineItem/${n}0`,
          title: "Rip Tee",
          quantity: 1,
          product: { id: "gid://shopify/Product/9" },
          variant: { id: "gid://shopify/ProductVariant/99" },
          originalUnitPriceSet: { shopMoney: { amount: "20.00" } },
          discountedTotalSet: { shopMoney: { amount: "20.00" } },
        },
      ],
    },
    transactions: feeAmount
      ? [{ kind: "SALE", status: "SUCCESS", fees: [{ amount: { amount: feeAmount } }] }]
      : [{ kind: "SALE", status: "SUCCESS", fees: [] }],
  };
}

const gqlResponses: Array<Record<string, unknown>> = [];
const tokenResponses: Array<Record<string, unknown>> = [];
global.fetch = vi.fn(async (url: RequestInfo | URL) => {
  if (String(url).includes("/admin/oauth/access_token")) {
    const body = tokenResponses.shift();
    if (!body) throw new Error("Unexpected token exchange — no queued response");
    return new Response(JSON.stringify(body), { status: 200 });
  }
  const data = gqlResponses.shift();
  if (!data) throw new Error("Unexpected fetch — no queued response");
  return new Response(JSON.stringify({ data }), { status: 200 });
}) as typeof fetch;

beforeAll(async () => {
  const dir = path.resolve(__dirname, "../../../drizzle");
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    for (const stmt of readFileSync(path.join(dir, file), "utf8").split(
      "--> statement-breakpoint",
    )) {
      if (stmt.trim()) await client.exec(stmt);
    }
  }
  // A user to own the connection.
  await testDb.insert(schema.user).values({
    id: "user-1",
    name: "Nae",
    email: "nae@example.com",
    emailVerified: true,
  });
});

describe("shopify sync", () => {
  let connectionId: string;
  const jobId = randomUUID();

  it("creates a connection: exchanges credentials, encrypts everything", async () => {
    const { createConnection } = await import("./store");
    // First fetch: the client-credentials token exchange.
    tokenResponses.push({ access_token: "shpat_from_exchange", expires_in: 86399 });
    // Second fetch: shop info via GraphQL.
    gqlResponses.push({
      shop: { name: "Ripright", myshopifyDomain: "ripright.myshopify.com", currencyCode: "USD" },
    });
    const conn = await createConnection({
      userId: "user-1",
      shopDomain: "ripright.myshopify.com",
      clientId: "client-id-123456",
      clientSecret: "client-secret-abcdef",
    });
    connectionId = conn.id;
    expect(conn.shopName).toBe("Ripright");
    expect(conn.accessToken).toBe("shpat_from_exchange");

    const [row] = await testDb.select().from(schema.storeConnection);
    const { decryptSecret } = await import("@/lib/crypto");
    expect(row.encryptedClientSecret).not.toContain("client-secret-abcdef");
    expect(decryptSecret(row.encryptedClientSecret)).toBe("client-secret-abcdef");
    expect(decryptSecret(row.encryptedClientId)).toBe("client-id-123456");
    expect(decryptSecret(row.encryptedAccessToken!)).toBe("shpat_from_exchange");
    expect(row.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 80_000_000);
  });

  it("refreshes the access token when the cached one is near expiry", async () => {
    const { getAccessToken } = await import("./store");
    const { eq } = await import("drizzle-orm");
    // Force the cached token to look nearly expired.
    await testDb
      .update(schema.storeConnection)
      .set({ tokenExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(schema.storeConnection.id, connectionId));
    tokenResponses.push({ access_token: "shpat_refreshed", expires_in: 86399 });
    const [conn] = await testDb.select().from(schema.storeConnection);
    expect(await getAccessToken(conn)).toBe("shpat_refreshed");
    // And the fresh token is cached for next time.
    const [after] = await testDb.select().from(schema.storeConnection);
    const { decryptSecret } = await import("@/lib/crypto");
    expect(decryptSecret(after.encryptedAccessToken!)).toBe("shpat_refreshed");
  });

  it("backfills across pages and tracks progress", async () => {
    const { runSyncStep } = await import("./store");
    await testDb.insert(schema.syncJob).values({
      id: jobId,
      connectionId,
      startDate: new Date("2026-06-01"),
    });

    gqlResponses.push({
      orders: {
        pageInfo: { hasNextPage: true, endCursor: "cur-1" },
        nodes: [orderNode(1, "0.88")],
      },
    });
    let job = await runSyncStep(jobId);
    expect(job.status).toBe("running");
    expect(job.ordersSynced).toBe(1);

    gqlResponses.push({
      orders: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [orderNode(2, null)],
      },
    });
    job = await runSyncStep(jobId);
    expect(job.status).toBe("completed");
    expect(job.ordersSynced).toBe(2);

    const orders = await testDb.select().from(schema.shopifyOrder);
    expect(orders).toHaveLength(2);
    expect(orders.find((o) => o.orderNumber === "#1")?.feesCents).toBe(88);
    expect(orders.find((o) => o.orderNumber === "#2")?.feesCents).toBeNull(); // fee-hold
  });

  it("upserts are idempotent and pick up late fee data", async () => {
    const { upsertMappedOrder } = await import("./store");
    const { mapOrderNode } = await import("./mapping");
    // Same order re-arrives (e.g. via webhook) — now WITH fees.
    await upsertMappedOrder(connectionId, mapOrderNode(orderNode(2, "0.75"), connectionId));
    const orders = await testDb.select().from(schema.shopifyOrder);
    expect(orders).toHaveLength(2); // no duplicate
    expect(orders.find((o) => o.orderNumber === "#2")?.feesCents).toBe(75);
  });

  it("marks the job failed on API errors and supports retry", async () => {
    const { runSyncStep } = await import("./store");
    const retryJobId = randomUUID();
    await testDb.insert(schema.syncJob).values({
      id: retryJobId,
      connectionId,
      startDate: new Date("2026-06-01"),
    });
    global.fetch = vi.fn(async () => new Response("boom", { status: 500 })) as typeof fetch;
    const job = await runSyncStep(retryJobId);
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/500/);
  });
});
