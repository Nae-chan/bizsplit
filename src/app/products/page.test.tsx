import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";

/**
 * The catalog browse page against in-memory Postgres. The page is an async
 * server component, so it is called as the plain function it is and its output
 * rendered to markup — the states it owns (no connection, nothing synced, an
 * empty search, "Not set" versus a real cost, paging) are only distinguishable
 * from here.
 */

const client = new PGlite();
const testDb = drizzle(client, { schema });

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));

const state = vi.hoisted(() => ({ userId: "owner" }));
vi.mock("@/lib/session", () => ({
  requireSession: async () => ({ user: { id: state.userId } }),
}));
// The catalog sync button is a client component; outside Next there is no
// router mounted for it to read.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

process.env.TOKEN_ENCRYPTION_KEY = "integration-test-key";

const ownerConnectionId = randomUUID();
const otherConnectionId = randomUUID();

const P1 = "gid://shopify/Product/1";
const P2 = "gid://shopify/Product/2";
const P9 = "gid://shopify/Product/9";
const V1 = "gid://shopify/ProductVariant/101";
const V2 = "gid://shopify/ProductVariant/102";
const V9 = "gid://shopify/ProductVariant/901";

const SYNCED = new Date("2026-07-01T12:00:00.000Z");
/** Long in force / not yet in force, whatever the clock says when this runs. */
const LONG_AGO = new Date("2020-01-01T00:00:00.000Z");
const FAR_FUTURE = new Date("2999-01-01T00:00:00.000Z");

async function renderProducts(searchParams: { q?: string; page?: string } = {}) {
  const ProductsPage = (await import("./page")).default;
  return renderToStaticMarkup(await ProductsPage({ searchParams: Promise.resolve(searchParams) }));
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
  };
  await testDb.insert(schema.user).values([
    { id: "owner", name: "Nae", email: "nae@example.com", emailVerified: true },
    { id: "intruder", name: "Mal", email: "mal@example.com", emailVerified: true },
    { id: "newcomer", name: "Sam", email: "sam@example.com", emailVerified: true },
  ]);
  await testDb.insert(schema.storeConnection).values([
    {
      id: ownerConnectionId,
      userId: "owner",
      shopDomain: "ripright.myshopify.com",
      shopName: "Ripright",
      currency: "USD",
      ianaTimezone: "America/Los_Angeles",
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
  await testDb.delete(schema.variantCost);
  await testDb.delete(schema.shopifyVariant);
  await testDb.delete(schema.shopifyProduct);
  await testDb.insert(schema.shopifyProduct).values([
    {
      id: P1,
      connectionId: ownerConnectionId,
      title: "Alpha Tee",
      handle: "alpha-tee",
      status: "ACTIVE",
      shopifyUpdatedAt: SYNCED,
    },
    {
      id: P2,
      connectionId: ownerConnectionId,
      title: "Beta Hoodie",
      handle: "beta-hoodie",
      status: "ACTIVE",
      shopifyUpdatedAt: SYNCED,
    },
    {
      id: P9,
      connectionId: otherConnectionId,
      title: "Other Tee",
      handle: "other-tee",
      status: "ACTIVE",
      shopifyUpdatedAt: SYNCED,
    },
  ]);
  await testDb.insert(schema.shopifyVariant).values([
    {
      id: V1,
      productId: P1,
      title: "Black / S",
      sku: "ALPHA-S",
      position: 1,
      priceCents: 2500,
      shopifyUpdatedAt: SYNCED,
    },
    {
      id: V2,
      productId: P1,
      title: "Black / L",
      sku: null,
      position: 2,
      priceCents: 2500,
      shopifyUpdatedAt: SYNCED,
    },
    {
      id: V9,
      productId: P9,
      title: "Default",
      sku: "OTHER",
      position: 1,
      priceCents: 2500,
      shopifyUpdatedAt: SYNCED,
    },
  ]);
  state.userId = "owner";
});

async function seedCost(variantId: string, unitCostCents: number, effectiveFrom: Date) {
  await testDb.insert(schema.variantCost).values({
    id: randomUUID(),
    variantId,
    unitCostCents,
    currency: "USD",
    effectiveFrom,
    createdByUserId: "owner",
  });
}

describe("/products with no store connected", () => {
  it("points at the connect flow instead of an empty catalog", async () => {
    state.userId = "newcomer";
    const html = await renderProducts();

    expect(html).toContain("No store connected yet.");
    expect(html).toContain('href="/settings/store"');
    // Distinct from a connected store with nothing synced: no sync offer, no table.
    expect(html).not.toContain("Catalog not synced yet");
    expect(html).not.toContain("<table");
    expect(html).not.toContain("Alpha Tee");
  });
});

describe("/products with a connected but unsynced store", () => {
  it("offers a catalog sync rather than the connect flow", async () => {
    await testDb.delete(schema.shopifyVariant);
    await testDb.delete(schema.shopifyProduct);
    const html = await renderProducts();

    expect(html).toContain("Catalog not synced yet.");
    expect(html).toContain("Sync catalog");
    expect(html).not.toContain("No store connected yet.");
    expect(html).not.toContain("<table");
  });

  it("says a search matched nothing rather than that the catalog is unsynced", async () => {
    const html = await renderProducts({ q: "nothing-matches-this" });

    expect(html).toContain("No products match");
    expect(html).not.toContain("Catalog not synced yet");
    expect(html).not.toContain("Alpha Tee");
  });
});

describe("/products cost column", () => {
  it('shows "Not set" — never a zero amount — for a variant with no cost', async () => {
    const html = await renderProducts();

    expect(html).toContain("Not set");
    expect(html).not.toContain("$0.00");
  });

  it("shows the cost in force today formatted as money", async () => {
    await seedCost(V1, 1234, LONG_AGO);
    const html = await renderProducts();

    expect(html).toContain("$12.34");
    // V2 still has none, so both renderings appear side by side.
    expect(html).toContain("Not set");
    expect(html).not.toContain("$0.00");
  });

  it("shows a zero cost as an amount, because zero is a real cost", async () => {
    await seedCost(V1, 0, LONG_AGO);
    const html = await renderProducts();

    expect(html).toContain("$0.00");
  });

  it('treats a cost that is not yet in force as "Not set"', async () => {
    await seedCost(V1, 1234, FAR_FUTURE);
    const html = await renderProducts();

    expect(html).not.toContain("$12.34");
    expect(html).toContain("Not set");
  });

  it("uses the newest cost in force when a variant has a history", async () => {
    await seedCost(V1, 800, LONG_AGO);
    await seedCost(V1, 950, new Date("2021-01-01T00:00:00.000Z"));
    const html = await renderProducts();

    expect(html).toContain("$9.50");
    expect(html).not.toContain("$8.00");
  });
});

describe("/products listing", () => {
  it("lists the caller's products and variants, and links each variant by its GID", async () => {
    const html = await renderProducts();

    expect(html).toContain("Alpha Tee");
    expect(html).toContain("Black / S");
    expect(html).toContain("ALPHA-S");
    expect(html).toContain("$25.00");
    expect(html).toContain(`href="/products/${encodeURIComponent(V1)}"`);
  });

  it("never shows another user's catalog", async () => {
    const html = await renderProducts();

    expect(html).toContain("Alpha Tee");
    expect(html).not.toContain("Other Tee");
    expect(html).not.toContain("OTHER");
  });

  it("tells the merchant when a product has no variants", async () => {
    await testDb.delete(schema.shopifyVariant).where(eq(schema.shopifyVariant.productId, P2));
    const html = await renderProducts();

    expect(html).toContain("No variants synced for this product.");
  });

  it("pages, offering Next only while more products exist", async () => {
    await testDb.insert(schema.shopifyProduct).values(
      Array.from({ length: 25 }, (_, i) => ({
        id: `gid://shopify/Product/page-${i}`,
        connectionId: ownerConnectionId,
        title: `Paged ${String(i).padStart(2, "0")}`,
        handle: `paged-${i}`,
        status: "ACTIVE",
        shopifyUpdatedAt: SYNCED,
      })),
    );

    const first = await renderProducts();
    expect(first).toContain('href="/products?page=2"');
    expect(first).not.toContain('rel="prev"');
    expect(first).toContain("Alpha Tee");
    // 27 products, 25 to a page: the last two land on page 2.
    expect(first).not.toContain("Paged 24");

    const second = await renderProducts({ page: "2" });
    expect(second).toContain("Paged 24");
    expect(second).toContain('href="/products"');
    expect(second).not.toContain("Alpha Tee");
    expect(second).not.toContain('href="/products?page=3"');
  });

  it("keeps the search term on the paging links", async () => {
    await testDb.insert(schema.shopifyProduct).values(
      Array.from({ length: 25 }, (_, i) => ({
        id: `gid://shopify/Product/tee-${i}`,
        connectionId: ownerConnectionId,
        title: `Tee ${String(i).padStart(2, "0")}`,
        handle: `tee-${i}`,
        status: "ACTIVE",
        shopifyUpdatedAt: SYNCED,
      })),
    );

    const html = await renderProducts({ q: "tee" });
    expect(html).toContain('href="/products?q=tee&amp;page=2"');
    expect(html).toContain('value="tee"');
  });
});
