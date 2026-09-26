import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createHmac, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";

/**
 * Catalog sync end-to-end: in-memory Postgres + mocked Shopify GraphQL API.
 * Exercises the paged product backfill (runProductSyncStep), cursor handoff,
 * idempotent upserts, resuming a failed job, token/scope failures, the
 * incremental "updated since" query, and soft deletes.
 * Every case starts from an empty catalog and an empty response queue.
 */

const client = new PGlite();
const testDb = drizzle(client, { schema });

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

process.env.TOKEN_ENCRYPTION_KEY = "integration-test-key";

function productNode(
  n: number,
  opts: { title?: string; price?: string; variants?: number[]; hasMoreVariants?: boolean } = {},
) {
  return {
    id: `gid://shopify/Product/${n}`,
    title: opts.title ?? `Product ${n}`,
    handle: `product-${n}`,
    status: "ACTIVE",
    productType: "Shirts",
    vendor: "Ripright",
    updatedAt: "2026-07-01T12:05:00Z",
    featuredImage: { url: `https://cdn.shopify.com/${n}.png` },
    variants: {
      pageInfo: { hasNextPage: opts.hasMoreVariants ?? false },
      nodes: (opts.variants ?? [1]).map((v) => ({
        id: `gid://shopify/ProductVariant/${n}0${v}`,
        title: `Black / ${v}`,
        sku: `SKU-${n}-${v}`,
        position: v,
        price: opts.price ?? "22.50",
        updatedAt: "2026-07-01T12:05:00Z",
      })),
    },
  };
}

const SHOP_RESPONSE = {
  shop: {
    name: "Ripright",
    myshopifyDomain: "ripright.myshopify.com",
    currencyCode: "USD",
    ianaTimezone: "America/New_York",
  },
};

/** Queued GraphQL replies: a data object, or a Response to simulate an HTTP failure. */
const gqlResponses: Array<Record<string, unknown> | Response> = [];
/** Queued token-exchange replies; the queue is optional and defaults to success. */
const tokenResponses: Response[] = [];
const gqlRequests: Array<{ query: string; variables: Record<string, unknown> }> = [];

function installFetchMock() {
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).includes("/admin/oauth/access_token")) {
      return (
        tokenResponses.shift() ??
        new Response(JSON.stringify({ access_token: "shpat_test", expires_in: 86399 }), {
          status: 200,
        })
      );
    }
    gqlRequests.push(JSON.parse(String(init?.body)));
    const queued = gqlResponses.shift();
    if (!queued) throw new Error("Unexpected fetch — no queued response");
    if (queued instanceof Response) return queued;
    return new Response(JSON.stringify({ data: queued }), { status: 200 });
  }) as typeof fetch;
}

const connectionId = randomUUID();

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
  await testDb.insert(schema.user).values({
    id: "user-1",
    name: "Nae",
    email: "nae@example.com",
    emailVerified: true,
  });
  await testDb.insert(schema.storeConnection).values({
    id: connectionId,
    userId: "user-1",
    shopDomain: "ripright.myshopify.com",
    shopName: "Ripright",
    currency: "USD",
    encryptedClientId: encryptSecret("client-id-123456"),
    encryptedClientSecret: encryptSecret("client-secret-abcdef"),
    encryptedAccessToken: encryptSecret("shpat_cached"),
    tokenExpiresAt: new Date(Date.now() + 86_400_000),
  });
});

beforeEach(async () => {
  // Each case gets a clean catalog, a clean job table and an empty queue, so
  // nothing depends on the case that ran before it.
  await testDb.delete(schema.variantCost);
  await testDb.delete(schema.shopifyVariant);
  await testDb.delete(schema.shopifyProduct);
  await testDb.delete(schema.syncJob);
  await testDb
    .update(schema.storeConnection)
    .set({ ianaTimezone: null, tokenExpiresAt: new Date(Date.now() + 86_400_000) })
    .where(eq(schema.storeConnection.id, connectionId));
  gqlResponses.length = 0;
  gqlRequests.length = 0;
  tokenResponses.length = 0;
  installFetchMock();
});

describe("catalog sync", () => {
  it("syncs products across pages and tracks progress", async () => {
    const { runProductSyncStep, startCatalogSync } = await import("./catalog");
    const job = await startCatalogSync(connectionId);
    expect(job.kind).toBe("products");
    expect(job.startDate).toBeNull(); // full sync

    // The first step of a run also refreshes the shop timezone.
    gqlResponses.push(SHOP_RESPONSE);
    gqlResponses.push({
      products: {
        pageInfo: { hasNextPage: true, endCursor: "cur-1" },
        nodes: [productNode(1), productNode(2)],
      },
    });
    let progress = await runProductSyncStep(job.id);
    expect(progress.status).toBe("running");
    expect(progress.itemsSynced).toBe(2);
    expect(progress.cursor).toBe("cur-1");

    gqlResponses.push({
      products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [productNode(3)] },
    });
    progress = await runProductSyncStep(job.id);
    expect(progress.status).toBe("completed");
    expect(progress.itemsSynced).toBe(3);

    // The cursor round-trips: page two asks Shopify to continue after page one.
    const pages = gqlRequests.filter((r) => r.query.includes("BizsplitProductsPage"));
    expect(pages).toHaveLength(2);
    expect(pages[0].variables.after).toBeNull();
    expect(pages[1].variables.after).toBe("cur-1");

    const products = await testDb.select().from(schema.shopifyProduct);
    expect(products).toHaveLength(3);
    expect(products.every((p) => p.connectionId === connectionId)).toBe(true);
    const variants = await testDb.select().from(schema.shopifyVariant);
    expect(variants).toHaveLength(3);
    const first = variants.find((v) => v.id === "gid://shopify/ProductVariant/101")!;
    expect(first.priceCents).toBe(2250);
    expect(Number.isInteger(first.priceCents)).toBe(true);
    expect(first.sku).toBe("SKU-1-1");

    // Timezone captured for effective-date interpretation.
    const [conn] = await testDb.select().from(schema.storeConnection);
    expect(conn.ianaTimezone).toBe("America/New_York");
  });

  it("clears the shop timezone when the shop no longer reports one", async () => {
    const { runProductSyncStep, startCatalogSync } = await import("./catalog");
    await testDb
      .update(schema.storeConnection)
      .set({ ianaTimezone: "America/New_York" })
      .where(eq(schema.storeConnection.id, connectionId));

    const job = await startCatalogSync(connectionId);
    gqlResponses.push({
      shop: { name: "Ripright", myshopifyDomain: "ripright.myshopify.com", currencyCode: "USD" },
    });
    gqlResponses.push({
      products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    });
    await runProductSyncStep(job.id);

    const [conn] = await testDb.select().from(schema.storeConnection);
    expect(conn.ianaTimezone).toBeNull(); // costs fall back to UTC
  });

  it("re-syncing the same product updates it without duplicating rows", async () => {
    const { upsertMappedProduct } = await import("./catalog");
    const { mapProductNode } = await import("./mapping");
    await upsertMappedProduct(connectionId, mapProductNode(productNode(1)));
    await upsertMappedProduct(
      connectionId,
      mapProductNode(productNode(1, { title: "Renamed Tee", price: "19.99" })),
    );

    const products = await testDb.select().from(schema.shopifyProduct);
    expect(products).toHaveLength(1); // no duplicate
    expect(products[0].title).toBe("Renamed Tee");
    const variants = await testDb.select().from(schema.shopifyVariant);
    expect(variants).toHaveLength(1);
    expect(variants[0].priceCents).toBe(1999);
  });

  it("marks the job failed on API errors and a follow-up job resumes the sync", async () => {
    const { runProductSyncStep, startCatalogSync } = await import("./catalog");
    const failing = await testDb
      .insert(schema.syncJob)
      .values({ id: randomUUID(), connectionId, kind: "products" })
      .returning();
    global.fetch = vi.fn(async () => new Response("boom", { status: 500 })) as typeof fetch;
    const failed = await runProductSyncStep(failing[0].id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/500/);

    // A failed job frees the connection for a new one, which runs to completion.
    installFetchMock();
    const retry = await startCatalogSync(connectionId);
    expect(retry.id).not.toBe(failing[0].id);
    gqlResponses.push(SHOP_RESPONSE);
    gqlResponses.push({
      products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [productNode(4)] },
    });
    const done = await runProductSyncStep(retry.id);
    expect(done.status).toBe("completed");
    expect(done.itemsSynced).toBe(1);
  });

  it("resumes a failed job from its cursor, keeping the progress it made", async () => {
    const { runProductSyncStep, startCatalogSync } = await import("./catalog");
    const job = await startCatalogSync(connectionId);

    gqlResponses.push(SHOP_RESPONSE);
    gqlResponses.push({
      products: {
        pageInfo: { hasNextPage: true, endCursor: "cur-1" },
        nodes: [productNode(1), productNode(2)],
      },
    });
    const afterPageOne = await runProductSyncStep(job.id);
    expect(afterPageOne.itemsSynced).toBe(2);

    // Page two blows up. The job keeps the cursor and count it already earned.
    gqlResponses.push(new Response("boom", { status: 500 }));
    const failed = await runProductSyncStep(job.id);
    expect(failed.status).toBe("failed");
    expect(failed.cursor).toBe("cur-1");
    expect(failed.itemsSynced).toBe(2);

    // Retry the same job (what the Retry button does): it resumes from cur-1.
    gqlRequests.length = 0;
    gqlResponses.push({
      products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [productNode(3)] },
    });
    const resumed = await runProductSyncStep(job.id);
    expect(resumed.status).toBe("completed");
    expect(resumed.itemsSynced).toBe(3); // page one's two products were not lost
    expect(resumed.error).toBeNull();
    const page = gqlRequests.find((r) => r.query.includes("BizsplitProductsPage"));
    expect(page?.variables.after).toBe("cur-1");
    expect(await testDb.select().from(schema.shopifyProduct)).toHaveLength(3);
  });

  it("leaves a completed job alone when it is stepped again", async () => {
    const { runProductSyncStep, startCatalogSync } = await import("./catalog");
    const job = await startCatalogSync(connectionId);
    gqlResponses.push(SHOP_RESPONSE);
    gqlResponses.push({
      products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [productNode(1)] },
    });
    await runProductSyncStep(job.id);

    // No queued response: a completed job must not call Shopify again.
    const again = await runProductSyncStep(job.id);
    expect(again.status).toBe("completed");
    expect(again.itemsSynced).toBe(1);
  });

  it("fails the job with a reconnect hint when the token exchange fails", async () => {
    const { runProductSyncStep, startCatalogSync } = await import("./catalog");
    // Force a re-exchange by expiring the cached token, then reject it.
    await testDb
      .update(schema.storeConnection)
      .set({ tokenExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(schema.storeConnection.id, connectionId));
    tokenResponses.push(new Response("nope", { status: 401 }));

    const job = await startCatalogSync(connectionId);
    const failed = await runProductSyncStep(job.id);
    expect(failed.status).toBe("failed"); // not left running forever
    expect(failed.error).toMatch(/Token exchange failed \(401\)/);
    expect(failed.error).toMatch(/reconnect the store/i);

    // And the job is retryable rather than a permanent lock on the connection.
    await testDb
      .update(schema.storeConnection)
      .set({ tokenExpiresAt: new Date(Date.now() + 86_400_000) })
      .where(eq(schema.storeConnection.id, connectionId));
    gqlResponses.push(SHOP_RESPONSE);
    gqlResponses.push({
      products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [productNode(1)] },
    });
    const retried = await runProductSyncStep(job.id);
    expect(retried.status).toBe("completed");
  });

  it("fails a 403 with a read_products remediation hint", async () => {
    const { runProductSyncStep, startCatalogSync } = await import("./catalog");
    const job = await startCatalogSync(connectionId);
    gqlResponses.push(SHOP_RESPONSE);
    gqlResponses.push(new Response("forbidden", { status: 403 }));

    const failed = await runProductSyncStep(job.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/403/);
    expect(failed.error).toMatch(/read_products/);
  });

  it("re-attaches to a running job instead of starting a second one", async () => {
    const { startCatalogSync } = await import("./catalog");
    const first = await testDb
      .insert(schema.syncJob)
      .values({ id: randomUUID(), connectionId, kind: "products" })
      .returning();
    const again = await startCatalogSync(connectionId);
    expect(again.id).toBe(first[0].id);
  });

  it("sends an updated_at floor for an incremental job", async () => {
    const { runProductSyncStep, startCatalogSync } = await import("./catalog");
    const since = new Date("2026-08-01T00:00:00.000Z");
    const job = await startCatalogSync(connectionId, since);
    expect(job.startDate?.toISOString()).toBe(since.toISOString());

    gqlResponses.push(SHOP_RESPONSE);
    gqlResponses.push({
      products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    });
    await runProductSyncStep(job.id);

    const productsRequest = gqlRequests.find((r) => r.query.includes("BizsplitProductsPage"));
    expect(productsRequest?.variables.query).toBe("updated_at:>='2026-08-01T00:00:00.000Z'");
    expect(productsRequest?.variables.first).toBe(25);
  });

  it("omits the query argument for a full sync", async () => {
    const { runProductSyncStep, startCatalogSync } = await import("./catalog");
    const job = await startCatalogSync(connectionId);
    gqlResponses.push(SHOP_RESPONSE);
    gqlResponses.push({
      products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    });
    await runProductSyncStep(job.id);
    const productsRequest = gqlRequests.find((r) => r.query.includes("BizsplitProductsPage"));
    expect(productsRequest?.variables.query).toBeUndefined();
  });

  it("reports the last completed catalog sync for the next incremental run", async () => {
    const { lastCompletedCatalogSyncAt } = await import("./catalog");
    expect(await lastCompletedCatalogSyncAt(connectionId)).toBeUndefined();
    const [completed] = await testDb
      .insert(schema.syncJob)
      .values({ id: randomUUID(), connectionId, kind: "products", status: "completed" })
      .returning();
    expect((await lastCompletedCatalogSyncAt(connectionId))?.getTime()).toBe(
      completed.createdAt.getTime(),
    );
  });

  it("takes the incremental floor from the last completed job, not a newer failed one", async () => {
    const { lastCompletedCatalogSyncAt } = await import("./catalog");
    const completedAt = new Date("2026-08-01T00:00:00.000Z");
    await testDb.insert(schema.syncJob).values([
      {
        id: randomUUID(),
        connectionId,
        kind: "products",
        status: "completed",
        createdAt: completedAt,
      },
      // A later run that died partway. Its timestamp is not a safe floor: every
      // product it never reached would be skipped by the next incremental sync.
      {
        id: randomUUID(),
        connectionId,
        kind: "products",
        status: "failed",
        error: "Shopify responded 500",
        createdAt: new Date("2026-08-20T00:00:00.000Z"),
      },
      // Nor is a run that is still going.
      {
        id: randomUUID(),
        connectionId,
        kind: "products",
        status: "running",
        createdAt: new Date("2026-08-25T00:00:00.000Z"),
      },
    ]);

    expect((await lastCompletedCatalogSyncAt(connectionId))?.toISOString()).toBe(
      completedAt.toISOString(),
    );
  });

  it("ignores completed order jobs and other connections when choosing the floor", async () => {
    const { lastCompletedCatalogSyncAt } = await import("./catalog");
    await testDb.insert(schema.syncJob).values({
      id: randomUUID(),
      connectionId,
      kind: "orders",
      status: "completed",
      startDate: new Date("2026-01-01T00:00:00.000Z"),
      createdAt: new Date("2026-08-20T00:00:00.000Z"),
    });
    expect(await lastCompletedCatalogSyncAt(connectionId)).toBeUndefined();
  });

  it("soft-deletes a product, keeping its variants and cost history", async () => {
    const { markProductDeleted, upsertMappedProduct } = await import("./catalog");
    const { mapProductNode } = await import("./mapping");

    await upsertMappedProduct(connectionId, mapProductNode(productNode(7)));
    const costId = randomUUID();
    await testDb.insert(schema.variantCost).values({
      id: costId,
      variantId: "gid://shopify/ProductVariant/701",
      unitCostCents: 800,
      currency: "USD",
      effectiveFrom: new Date("2026-03-01T00:00:00.000Z"),
      createdByUserId: "user-1",
    });

    await markProductDeleted("gid://shopify/Product/7");

    const [product] = await testDb
      .select()
      .from(schema.shopifyProduct)
      .where(eq(schema.shopifyProduct.id, "gid://shopify/Product/7"));
    expect(product.deletedAt).toBeInstanceOf(Date);
    const [variant] = await testDb
      .select()
      .from(schema.shopifyVariant)
      .where(eq(schema.shopifyVariant.id, "gid://shopify/ProductVariant/701"));
    expect(variant.deletedAt).toBeInstanceOf(Date);
    const costs = await testDb
      .select()
      .from(schema.variantCost)
      .where(eq(schema.variantCost.id, costId));
    expect(costs).toHaveLength(1);
    expect(costs[0].unitCostCents).toBe(800);
  });

  it("clears deleted_at when a deleted product reappears upstream", async () => {
    const { markProductDeleted, upsertMappedProduct } = await import("./catalog");
    const { mapProductNode } = await import("./mapping");

    await upsertMappedProduct(connectionId, mapProductNode(productNode(7)));
    await markProductDeleted("gid://shopify/Product/7");
    await upsertMappedProduct(connectionId, mapProductNode(productNode(7)));

    const [product] = await testDb
      .select()
      .from(schema.shopifyProduct)
      .where(eq(schema.shopifyProduct.id, "gid://shopify/Product/7"));
    expect(product.deletedAt).toBeNull();
    const [variant] = await testDb
      .select()
      .from(schema.shopifyVariant)
      .where(eq(schema.shopifyVariant.id, "gid://shopify/ProductVariant/701"));
    expect(variant.deletedAt).toBeNull();
  });

  it("soft-deletes a variant that disappeared from the product upstream", async () => {
    const { upsertMappedProduct } = await import("./catalog");
    const { mapProductNode } = await import("./mapping");

    await upsertMappedProduct(connectionId, mapProductNode(productNode(5, { variants: [1, 2] })));
    // The merchant removes the second variant; the payload now omits it.
    await upsertMappedProduct(connectionId, mapProductNode(productNode(5, { variants: [1] })));

    const kept = await testDb
      .select()
      .from(schema.shopifyVariant)
      .where(eq(schema.shopifyVariant.id, "gid://shopify/ProductVariant/501"));
    expect(kept[0].deletedAt).toBeNull();
    const removed = await testDb
      .select()
      .from(schema.shopifyVariant)
      .where(eq(schema.shopifyVariant.id, "gid://shopify/ProductVariant/502"));
    expect(removed).toHaveLength(1); // soft delete, never a row removal
    expect(removed[0].deletedAt).toBeInstanceOf(Date);

    // And it comes back live when the merchant restores it.
    await upsertMappedProduct(connectionId, mapProductNode(productNode(5, { variants: [1, 2] })));
    const restored = await testDb
      .select()
      .from(schema.shopifyVariant)
      .where(eq(schema.shopifyVariant.id, "gid://shopify/ProductVariant/502"));
    expect(restored[0].deletedAt).toBeNull();
  });

  it("keeps a variant's original deleted_at when the product is synced again", async () => {
    const { upsertMappedProduct } = await import("./catalog");
    const { mapProductNode } = await import("./mapping");

    await upsertMappedProduct(connectionId, mapProductNode(productNode(5, { variants: [1, 2] })));
    await upsertMappedProduct(connectionId, mapProductNode(productNode(5, { variants: [1] })));
    const [first] = await testDb
      .select()
      .from(schema.shopifyVariant)
      .where(eq(schema.shopifyVariant.id, "gid://shopify/ProductVariant/502"));
    expect(first.deletedAt).toBeInstanceOf(Date);
    await upsertMappedProduct(connectionId, mapProductNode(productNode(5, { variants: [1] })));
    const [second] = await testDb
      .select()
      .from(schema.shopifyVariant)
      .where(eq(schema.shopifyVariant.id, "gid://shopify/ProductVariant/502"));
    expect(second.deletedAt?.getTime()).toBe(first.deletedAt?.getTime());
  });

  it("does not prune variants when the product has more than one page of them", async () => {
    const { upsertMappedProduct } = await import("./catalog");
    const { mapProductNode } = await import("./mapping");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await upsertMappedProduct(connectionId, mapProductNode(productNode(6, { variants: [1, 2] })));
    // A partial payload: variant 2 is simply beyond the first page, not deleted.
    await upsertMappedProduct(
      connectionId,
      mapProductNode(productNode(6, { variants: [1], hasMoreVariants: true })),
    );

    const unseen = await testDb
      .select()
      .from(schema.shopifyVariant)
      .where(eq(schema.shopifyVariant.id, "gid://shopify/ProductVariant/602"));
    expect(unseen[0].deletedAt).toBeNull();
    warn.mockRestore();
  });
});

describe("product webhooks", () => {
  function signedRequest(topic: string, payload: Record<string, unknown>) {
    const body = JSON.stringify(payload);
    const hmac = createHmac("sha256", "client-secret-abcdef").update(body, "utf8").digest("base64");
    return new Request("https://bizsplit.test/api/webhooks/shopify", {
      method: "POST",
      headers: {
        "x-shopify-hmac-sha256": hmac,
        "x-shopify-shop-domain": "ripright.myshopify.com",
        "x-shopify-topic": topic,
      },
      body,
    });
  }

  it("products/update re-fetches the product and upserts it", async () => {
    const { POST } = await import("@/app/api/webhooks/shopify/route");
    gqlResponses.push({ product: productNode(8, { title: "Webhook Tee", price: "31.00" }) });

    const res = await POST(
      signedRequest("products/update", {
        id: 8,
        admin_graphql_api_id: "gid://shopify/Product/8",
        // Deliberately wrong: the payload is never trusted, the re-fetch wins.
        title: "Payload Title",
      }),
    );
    expect(res.status).toBe(200);

    const [product] = await testDb
      .select()
      .from(schema.shopifyProduct)
      .where(eq(schema.shopifyProduct.id, "gid://shopify/Product/8"));
    expect(product.title).toBe("Webhook Tee");
    const [variant] = await testDb
      .select()
      .from(schema.shopifyVariant)
      .where(eq(schema.shopifyVariant.id, "gid://shopify/ProductVariant/801"));
    expect(variant.priceCents).toBe(3100);
  });

  it("products/delete soft-deletes without calling the API", async () => {
    const { POST } = await import("@/app/api/webhooks/shopify/route");
    const { upsertMappedProduct } = await import("./catalog");
    const { mapProductNode } = await import("./mapping");
    await upsertMappedProduct(connectionId, mapProductNode(productNode(8)));

    // No queued GraphQL response: the delete path must not fetch.
    const res = await POST(signedRequest("products/delete", { id: 8 }));
    expect(res.status).toBe(200);

    const [product] = await testDb
      .select()
      .from(schema.shopifyProduct)
      .where(eq(schema.shopifyProduct.id, "gid://shopify/Product/8"));
    expect(product.deletedAt).toBeInstanceOf(Date);
    const [variant] = await testDb
      .select()
      .from(schema.shopifyVariant)
      .where(eq(schema.shopifyVariant.id, "gid://shopify/ProductVariant/801"));
    expect(variant.deletedAt).toBeInstanceOf(Date);
  });

  it("rejects a webhook with a bad signature", async () => {
    const { POST } = await import("@/app/api/webhooks/shopify/route");
    const res = await POST(
      new Request("https://bizsplit.test/api/webhooks/shopify", {
        method: "POST",
        headers: {
          "x-shopify-hmac-sha256": "not-the-right-signature",
          "x-shopify-shop-domain": "ripright.myshopify.com",
          "x-shopify-topic": "products/delete",
        },
        body: JSON.stringify({ id: 8 }),
      }),
    );
    expect(res.status).toBe(401);
  });
});
