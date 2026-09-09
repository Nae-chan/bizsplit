import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";

/**
 * The two browser-driven sync routes against in-memory Postgres:
 * /api/store/sync-step (authorization, job-kind dispatch, response shape) and
 * /api/store/catalog-sync (start, re-attach, incremental handoff). Handlers are
 * called directly as plain functions with the session mocked.
 */

const client = new PGlite();
const testDb = drizzle(client, { schema });

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

const state = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: async () => (state.userId ? { user: { id: state.userId } } : null),
    },
  },
}));

process.env.TOKEN_ENCRYPTION_KEY = "integration-test-key";

const ownerConnectionId = randomUUID();
const otherConnectionId = randomUUID();

const gqlResponses: Array<Record<string, unknown>> = [];
const gqlRequests: Array<{ query: string; variables: Record<string, unknown> }> = [];
function installFetchMock() {
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).includes("/admin/oauth/access_token")) {
      return new Response(JSON.stringify({ access_token: "shpat_test", expires_in: 86399 }), {
        status: 200,
      });
    }
    gqlRequests.push(JSON.parse(String(init?.body)));
    const data = gqlResponses.shift();
    if (!data) throw new Error("Unexpected fetch — no queued response");
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as typeof fetch;
}

const SHOP_RESPONSE = {
  shop: {
    name: "Ripright",
    myshopifyDomain: "ripright.myshopify.com",
    currencyCode: "USD",
    ianaTimezone: "America/New_York",
  },
};

function stepRequest(jobId: unknown) {
  return new Request("https://bizsplit.test/api/store/sync-step", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId }),
  });
}

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
  const { encryptSecret } = await import("@/lib/crypto");
  const credentials = {
    encryptedClientId: encryptSecret("client-id-123456"),
    encryptedClientSecret: encryptSecret("client-secret-abcdef"),
    encryptedAccessToken: encryptSecret("shpat_cached"),
    tokenExpiresAt: new Date(Date.now() + 86_400_000),
  };
  await testDb.insert(schema.user).values([
    { id: "owner", name: "Nae", email: "nae@example.com", emailVerified: true },
    { id: "intruder", name: "Mal", email: "mal@example.com", emailVerified: true },
    { id: "storeless", name: "Sam", email: "sam@example.com", emailVerified: true },
  ]);
  await testDb.insert(schema.storeConnection).values([
    {
      id: ownerConnectionId,
      userId: "owner",
      shopDomain: "ripright.myshopify.com",
      shopName: "Ripright",
      currency: "USD",
      ...credentials,
    },
    {
      id: otherConnectionId,
      userId: "intruder",
      shopDomain: "malshop.myshopify.com",
      shopName: "Mal Shop",
      currency: "USD",
      ...credentials,
    },
  ]);
});

beforeEach(async () => {
  await testDb.delete(schema.syncJob);
  gqlResponses.length = 0;
  gqlRequests.length = 0;
  state.userId = "owner";
  installFetchMock();
});

async function insertJob(values: Partial<typeof schema.syncJob.$inferInsert> = {}) {
  const [job] = await testDb
    .insert(schema.syncJob)
    .values({ id: randomUUID(), connectionId: ownerConnectionId, ...values })
    .returning();
  return job;
}

describe("POST /api/store/sync-step", () => {
  it("rejects an unauthenticated caller", async () => {
    const { POST } = await import("@/app/api/store/sync-step/route");
    state.userId = null;
    const res = await POST(stepRequest(randomUUID()));
    expect(res.status).toBe(401);
  });

  it("rejects a missing jobId", async () => {
    const { POST } = await import("@/app/api/store/sync-step/route");
    const res = await POST(stepRequest(""));
    expect(res.status).toBe(400);
  });

  it("will not step a job belonging to another user", async () => {
    const { POST } = await import("@/app/api/store/sync-step/route");
    const job = await insertJob({ kind: "products" });
    state.userId = "intruder";

    const res = await POST(stepRequest(job.id));
    expect(res.status).toBe(404);
    expect(gqlRequests).toHaveLength(0); // no Shopify call on someone else's job

    const [after] = await testDb.select().from(schema.syncJob).where(eq(schema.syncJob.id, job.id));
    expect(after.status).toBe("running"); // untouched
    expect(after.itemsSynced).toBe(0);
  });

  it("steps a products job through the catalog path", async () => {
    const { POST } = await import("@/app/api/store/sync-step/route");
    const job = await insertJob({ kind: "products" });
    gqlResponses.push(SHOP_RESPONSE);
    gqlResponses.push({
      products: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          {
            id: "gid://shopify/Product/1",
            title: "Rip Tee",
            handle: "rip-tee",
            status: "ACTIVE",
            productType: "Shirts",
            vendor: "Ripright",
            updatedAt: "2026-07-01T12:05:00Z",
            featuredImage: null,
            variants: {
              pageInfo: { hasNextPage: false },
              nodes: [
                {
                  id: "gid://shopify/ProductVariant/101",
                  title: "Black / L",
                  sku: "SKU-1",
                  position: 1,
                  price: "22.50",
                  updatedAt: "2026-07-01T12:05:00Z",
                },
              ],
            },
          },
        ],
      },
    });

    const res = await POST(stepRequest(job.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "completed",
      kind: "products",
      itemsSynced: 1,
      error: null,
    });
    expect(gqlRequests.some((r) => r.query.includes("BizsplitProductsPage"))).toBe(true);
    expect(gqlRequests.some((r) => r.query.includes("BizsplitOrdersPage"))).toBe(false);
    expect(await testDb.select().from(schema.shopifyProduct)).toHaveLength(1);
  });

  it("steps an orders job through the order path", async () => {
    const { POST } = await import("@/app/api/store/sync-step/route");
    const job = await insertJob({ kind: "orders", startDate: new Date("2026-06-01") });
    gqlResponses.push({
      orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    });

    const res = await POST(stepRequest(job.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "completed",
      kind: "orders",
      itemsSynced: 0,
      error: null,
    });
    expect(gqlRequests.some((r) => r.query.includes("BizsplitOrdersPage"))).toBe(true);
    expect(gqlRequests.some((r) => r.query.includes("BizsplitProductsPage"))).toBe(false);
  });

  it("reports a failed step back to the browser with its error", async () => {
    const { POST } = await import("@/app/api/store/sync-step/route");
    const job = await insertJob({ kind: "products" });
    global.fetch = vi.fn(async () => new Response("boom", { status: 500 })) as typeof fetch;

    const res = await POST(stepRequest(job.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("failed");
    expect(body.error).toMatch(/500/);
  });
});

describe("POST /api/store/catalog-sync", () => {
  it("rejects an unauthenticated caller", async () => {
    const { POST } = await import("@/app/api/store/catalog-sync/route");
    state.userId = null;
    const res = await POST();
    expect(res.status).toBe(401);
  });

  it("404s when the caller has no connected store", async () => {
    const { POST } = await import("@/app/api/store/catalog-sync/route");
    state.userId = "storeless";
    const res = await POST();
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/no connected store/i);
  });

  it("starts a full catalog sync when there is no previous one", async () => {
    const { POST } = await import("@/app/api/store/catalog-sync/route");
    const res = await POST();
    expect(res.status).toBe(200);
    const { jobId } = await res.json();

    const [job] = await testDb.select().from(schema.syncJob).where(eq(schema.syncJob.id, jobId));
    expect(job.kind).toBe("products");
    expect(job.connectionId).toBe(ownerConnectionId);
    expect(job.startDate).toBeNull(); // full sync
  });

  it("409s with the running job's id instead of starting a second sync", async () => {
    const { POST } = await import("@/app/api/store/catalog-sync/route");
    const running = await insertJob({ kind: "products" });

    const res = await POST();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ jobId: running.id, alreadyRunning: true });
    expect(await testDb.select().from(schema.syncJob)).toHaveLength(1);
  });

  it("hands the last completed sync's timestamp to the next one as its floor", async () => {
    const { POST } = await import("@/app/api/store/catalog-sync/route");
    const completed = await insertJob({ kind: "products", status: "completed", itemsSynced: 3 });

    const res = await POST();
    expect(res.status).toBe(200);
    const { jobId } = await res.json();
    const [job] = await testDb.select().from(schema.syncJob).where(eq(schema.syncJob.id, jobId));
    expect(job.id).not.toBe(completed.id);
    expect(job.startDate?.getTime()).toBe(completed.createdAt.getTime()); // incremental
  });

  it("ignores a running orders job when deciding whether a catalog sync can start", async () => {
    const { POST } = await import("@/app/api/store/catalog-sync/route");
    await insertJob({ kind: "orders" });
    const res = await POST();
    expect(res.status).toBe(200);
    const { jobId } = await res.json();
    const [job] = await testDb.select().from(schema.syncJob).where(eq(schema.syncJob.id, jobId));
    expect(job.kind).toBe("products");
  });
});
