import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as schema from "@/db/schema";

/**
 * The variant cost page against in-memory Postgres. The page is an async server
 * component, so it is called as the plain function it is and its output
 * rendered to markup. What is pinned here is what the page itself owns: the
 * ownership guard (a variant belonging to another user is a 404, not a peek),
 * the decoding of the GID route segment, and "Not set" versus a real amount.
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
// notFound() is the real one — its throw is the page's 404. Only the router the
// cost form reads has to be stubbed, since no Next router is mounted here.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

process.env.TOKEN_ENCRYPTION_KEY = "integration-test-key";

const ownerConnectionId = randomUUID();
const otherConnectionId = randomUUID();

const P1 = "gid://shopify/Product/1";
const P9 = "gid://shopify/Product/9";
const V1 = "gid://shopify/ProductVariant/101";
const V9 = "gid://shopify/ProductVariant/901";
/** A GID that is not valid percent-encoding, to pin the defensive decode. */
const V_ODD = "gid://shopify/ProductVariant/100%";

const SYNCED = new Date("2026-07-01T12:00:00.000Z");
const LONG_AGO = new Date("2020-01-01T00:00:00.000Z");
const FAR_FUTURE = new Date("2999-01-01T00:00:00.000Z");

async function renderVariant(variantId: string) {
  const VariantCostPage = (await import("./page")).default;
  return renderToStaticMarkup(await VariantCostPage({ params: Promise.resolve({ variantId }) }));
}

/** A server component 404s by throwing Next's HTTP fallback error. */
async function expectNotFound(variantId: string) {
  const VariantCostPage = (await import("./page")).default;
  await expect(VariantCostPage({ params: Promise.resolve({ variantId }) })).rejects.toMatchObject({
    digest: "NEXT_HTTP_ERROR_FALLBACK;404",
  });
}

beforeAll(async () => {
  const dir = path.resolve(__dirname, "../../../../drizzle");
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
      id: P9,
      connectionId: otherConnectionId,
      title: "Secret Hoodie",
      handle: "secret-hoodie",
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
      id: V_ODD,
      productId: P1,
      title: "Odd / GID",
      sku: "ALPHA-ODD",
      position: 2,
      priceCents: 2500,
      shopifyUpdatedAt: SYNCED,
    },
    {
      id: V9,
      productId: P9,
      title: "Confidential",
      sku: "SECRET-SKU",
      position: 1,
      priceCents: 9900,
      shopifyUpdatedAt: SYNCED,
    },
  ]);
});

beforeEach(async () => {
  await testDb.delete(schema.variantCost);
  state.userId = "owner";
});

async function seedCost(values: Partial<typeof schema.variantCost.$inferInsert> = {}) {
  await testDb.insert(schema.variantCost).values({
    id: randomUUID(),
    variantId: V1,
    unitCostCents: 800,
    currency: "USD",
    effectiveFrom: LONG_AGO,
    createdByUserId: "owner",
    ...values,
  });
}

describe("/products/[variantId] ownership", () => {
  it("shows the variant to the user whose store it belongs to", async () => {
    const html = await renderVariant(encodeURIComponent(V1));

    expect(html).toContain("Alpha Tee");
    expect(html).toContain("Black / S");
    expect(html).toContain("ALPHA-S");
  });

  it("404s for another user's variant, leaking nothing about it", async () => {
    state.userId = "intruder";
    await expectNotFound(encodeURIComponent(V1));

    // ...and the same in the other direction: the guard is not one-sided.
    state.userId = "owner";
    await expectNotFound(encodeURIComponent(V9));
  });

  it("404s a variant that does not exist, the same answer as one that is not yours", async () => {
    await expectNotFound(encodeURIComponent("gid://shopify/ProductVariant/does-not-exist"));
  });

  it("does not render another user's variant details even in part", async () => {
    state.userId = "intruder";
    let html: string | null = null;
    try {
      html = await renderVariant(encodeURIComponent(V1));
    } catch {
      // notFound(): nothing was rendered at all.
    }
    expect(html).toBeNull();
  });
});

describe("/products/[variantId] GID decoding", () => {
  it("finds the variant from the percent-encoded segment the catalog links to", async () => {
    const html = await renderVariant(encodeURIComponent(V1));
    expect(html).toContain("Black / S");
  });

  it("finds the variant from an already-decoded segment", async () => {
    const html = await renderVariant(V1);
    expect(html).toContain("Black / S");
  });

  it("treats a segment that is not valid encoding as a literal instead of throwing", async () => {
    // decodeURIComponent("...100%") throws URIError; the page must fall back to
    // the raw segment rather than 500.
    const html = await renderVariant(V_ODD);
    expect(html).toContain("Odd / GID");
  });
});

describe("/products/[variantId] cost display", () => {
  it('shows "Not set" — not a zero amount — when no cost has been recorded', async () => {
    const html = await renderVariant(encodeURIComponent(V1));

    expect(html).toContain("Not set");
    expect(html).not.toContain("$0.00");
    expect(html).toContain("No cost recorded for this variant yet.");
  });

  it("shows the cost in force today, and the full history behind it", async () => {
    await seedCost({ unitCostCents: 800, effectiveFrom: LONG_AGO, note: "opening quote" });
    await seedCost({
      unitCostCents: 950,
      effectiveFrom: new Date("2021-06-01T00:00:00.000Z"),
      note: "supplier increase",
    });
    const html = await renderVariant(encodeURIComponent(V1));

    expect(html).toContain("$9.50");
    expect(html).toContain("$8.00"); // the older row is still listed
    expect(html).toContain("supplier increase");
    expect(html).toContain("opening quote");
    expect(html).not.toContain("Not set");
  });

  it('shows a scheduled cost in the history but keeps today "Not set"', async () => {
    await seedCost({ unitCostCents: 1234, effectiveFrom: FAR_FUTURE });
    const html = await renderVariant(encodeURIComponent(V1));

    expect(html).toContain("Not set");
    expect(html).toContain("$12.34"); // listed as history, not as today's cost
  });

  it("shows a zero cost as an amount, because zero is a real cost", async () => {
    await seedCost({ unitCostCents: 0 });
    const html = await renderVariant(encodeURIComponent(V1));

    expect(html).toContain("$0.00");
    expect(html).not.toContain("Not set");
  });

  it("says that adding a cost never replaces the older record", async () => {
    const html = await renderVariant(encodeURIComponent(V1));

    expect(html).toMatch(/never replaces an older record/i);
    expect(html).toContain("Add cost");
  });

  it("reads dates in the shop's timezone, and says so", async () => {
    const html = await renderVariant(encodeURIComponent(V1));

    expect(html).toContain("midnight in America/Los_Angeles");
  });
});
