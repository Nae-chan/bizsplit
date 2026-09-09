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
 * runOrderSyncStep, idempotent upserts, and the fee-pending state.
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

/** Queued GraphQL replies: a data object, or a Response to simulate an HTTP failure. */
const gqlResponses: Array<Record<string, unknown> | Response> = [];
const tokenResponses: Array<Record<string, unknown>> = [];
const gqlRequests: Array<{ query: string; variables: Record<string, unknown> }> = [];
function installFetchMock() {
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).includes("/admin/oauth/access_token")) {
      const body = tokenResponses.shift();
      if (!body) throw new Error("Unexpected token exchange — no queued response");
      return new Response(JSON.stringify(body), { status: 200 });
    }
    gqlRequests.push(JSON.parse(String(init?.body)));
    const queued = gqlResponses.shift();
    if (!queued) throw new Error("Unexpected fetch — no queued response");
    if (queued instanceof Response) return queued;
    return new Response(JSON.stringify({ data: queued }), { status: 200 });
  }) as typeof fetch;
}
installFetchMock();

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
    const { runOrderSyncStep } = await import("./store");
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
    let job = await runOrderSyncStep(jobId);
    expect(job.status).toBe("running");
    expect(job.itemsSynced).toBe(1);

    gqlResponses.push({
      orders: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [orderNode(2, null)],
      },
    });
    job = await runOrderSyncStep(jobId);
    expect(job.status).toBe("completed");
    expect(job.itemsSynced).toBe(2);

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
    const { runOrderSyncStep } = await import("./store");
    const retryJobId = randomUUID();
    await testDb.insert(schema.syncJob).values({
      id: retryJobId,
      connectionId,
      startDate: new Date("2026-06-01"),
    });
    global.fetch = vi.fn(async () => new Response("boom", { status: 500 })) as typeof fetch;
    const job = await runOrderSyncStep(retryJobId);
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/500/);
    installFetchMock();
  });

  it("resumes a failed order job from its cursor, keeping the progress it made", async () => {
    const { runOrderSyncStep } = await import("./store");
    const resumeJobId = randomUUID();
    await testDb.insert(schema.syncJob).values({
      id: resumeJobId,
      connectionId,
      startDate: new Date("2026-06-01"),
    });

    gqlResponses.push({
      orders: {
        pageInfo: { hasNextPage: true, endCursor: "cur-1" },
        nodes: [orderNode(3, "0.10")],
      },
    });
    const pageOne = await runOrderSyncStep(resumeJobId);
    expect(pageOne.itemsSynced).toBe(1);

    gqlResponses.push(new Response("boom", { status: 500 }));
    const failed = await runOrderSyncStep(resumeJobId);
    expect(failed.status).toBe("failed");
    expect(failed.cursor).toBe("cur-1");
    expect(failed.itemsSynced).toBe(1);

    // Re-stepping the same job (the Retry button) picks up where it stopped.
    gqlRequests.length = 0;
    gqlResponses.push({
      orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [orderNode(4, "0.20")] },
    });
    const resumed = await runOrderSyncStep(resumeJobId);
    expect(resumed.status).toBe("completed");
    expect(resumed.itemsSynced).toBe(2);
    expect(resumed.error).toBeNull();
    const page = gqlRequests.find((r) => r.query.includes("BizsplitOrdersPage"));
    expect(page?.variables.after).toBe("cur-1");
  });

  it("omits the created_at floor for a job with no start date", async () => {
    const { runOrderSyncStep } = await import("./store");
    const fullJobId = randomUUID();
    await testDb.insert(schema.syncJob).values({ id: fullJobId, connectionId });

    gqlRequests.length = 0;
    gqlResponses.push({
      orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    });
    await runOrderSyncStep(fullJobId);
    const page = gqlRequests.find((r) => r.query.includes("BizsplitOrdersPage"));
    expect(page?.variables.query).toBeUndefined();
  });

  it("fails the job with a reconnect hint when the token exchange fails", async () => {
    const { runOrderSyncStep } = await import("./store");
    const { eq } = await import("drizzle-orm");
    const tokenJobId = randomUUID();
    await testDb.insert(schema.syncJob).values({ id: tokenJobId, connectionId });
    // Expire the cached token so a step has to re-exchange, then reject it.
    await testDb
      .update(schema.storeConnection)
      .set({ tokenExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(schema.storeConnection.id, connectionId));
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/admin/oauth/access_token")) {
        return new Response("nope", { status: 401 });
      }
      throw new Error("The sync must not reach the API without a token");
    }) as typeof fetch;

    const job = await runOrderSyncStep(tokenJobId);
    expect(job.status).toBe("failed"); // not left running forever
    expect(job.error).toMatch(/Token exchange failed \(401\)/);
    expect(job.error).toMatch(/reconnect the store/i);
    installFetchMock();
  });
});
