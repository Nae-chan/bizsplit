import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import * as schema from "@/db/schema";

/**
 * Costs against in-memory Postgres: date-based resolution over real rows, the
 * append-only guarantee at the database level, catalog browsing, and the
 * /api/costs handler (called directly as a plain function with the session
 * mocked, as in sync-routes.integration.test.ts).
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
/** The other user's shop reports no timezone: its dates fall back to UTC. */
const otherConnectionId = randomUUID();

const P1 = "gid://shopify/Product/1";
const P2 = "gid://shopify/Product/2";
const P3 = "gid://shopify/Product/3";
const P9 = "gid://shopify/Product/9";
const V1 = "gid://shopify/ProductVariant/101";
const V2 = "gid://shopify/ProductVariant/102";
const V3 = "gid://shopify/ProductVariant/201";
const V4 = "gid://shopify/ProductVariant/301";
const V9 = "gid://shopify/ProductVariant/901";

const SYNCED = new Date("2026-07-01T12:00:00.000Z");

function variantRow(v: {
  id: string;
  productId: string;
  title: string;
  sku: string | null;
  position: number;
}) {
  return { ...v, priceCents: 2500, shopifyUpdatedAt: SYNCED };
}

function costRequest(body: unknown) {
  return new Request("https://bizsplit.test/api/costs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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
      ianaTimezone: null,
      ...credentials,
    },
  ]);
});

beforeEach(async () => {
  // Every case starts from the same catalog and no costs at all.
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
      status: "DRAFT",
      shopifyUpdatedAt: SYNCED,
    },
    {
      id: P3,
      connectionId: ownerConnectionId,
      title: "Zeta Cap",
      handle: "zeta-cap",
      status: "ARCHIVED",
      deletedAt: SYNCED,
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
  await testDb
    .insert(schema.shopifyVariant)
    .values([
      variantRow({ id: V1, productId: P1, title: "Black / S", sku: "ALPHA-S", position: 1 }),
      variantRow({ id: V2, productId: P1, title: "Black / L", sku: "ALPHA-L", position: 2 }),
      variantRow({ id: V3, productId: P2, title: "Default", sku: null, position: 1 }),
      variantRow({ id: V4, productId: P3, title: "Default", sku: "ZETA", position: 1 }),
      variantRow({ id: V9, productId: P9, title: "Default", sku: "OTHER", position: 1 }),
    ]);
  state.userId = "owner";
});

async function seedCost(values: Partial<typeof schema.variantCost.$inferInsert> = {}) {
  const [row] = await testDb
    .insert(schema.variantCost)
    .values({
      id: randomUUID(),
      variantId: V1,
      unitCostCents: 800,
      currency: "USD",
      effectiveFrom: new Date("2026-03-01T00:00:00.000Z"),
      createdByUserId: "owner",
      ...values,
    })
    .returning();
  return row;
}

describe("cost resolution over stored rows", () => {
  it("resolves an order to the cost in force when it was placed", async () => {
    const { resolveVariantCostAt } = await import("./store");
    await seedCost({ unitCostCents: 800, effectiveFrom: new Date("2026-03-01T00:00:00.000Z") });
    await seedCost({ unitCostCents: 950, effectiveFrom: new Date("2026-06-01T00:00:00.000Z") });

    const inApril = await resolveVariantCostAt(V1, new Date("2026-04-15T00:00:00.000Z"));
    expect(inApril?.unitCostCents).toBe(800);
    const inJuly = await resolveVariantCostAt(V1, new Date("2026-07-01T00:00:00.000Z"));
    expect(inJuly?.unitCostCents).toBe(950);
    // Before any cost existed: unknown, not free.
    expect(await resolveVariantCostAt(V1, new Date("2026-01-01T00:00:00.000Z"))).toBeNull();
  });

  it("returns null for a variant that has never had a cost", async () => {
    const { resolveVariantCostAt } = await import("./store");
    expect(await resolveVariantCostAt(V2, new Date("2026-09-09T00:00:00.000Z"))).toBeNull();
  });

  it("keeps both rows when a cost is edited, and old orders keep the old cost", async () => {
    const { insertVariantCost, resolveVariantCostAt } = await import("./store");
    const original = await insertVariantCost({
      variantId: V1,
      unitCostCents: 800,
      currency: "USD",
      effectiveFrom: new Date("2026-03-01T00:00:00.000Z"),
      createdByUserId: "owner",
    });
    await insertVariantCost({
      variantId: V1,
      unitCostCents: 950,
      currency: "USD",
      effectiveFrom: new Date("2026-06-01T00:00:00.000Z"),
      note: "supplier increase",
      createdByUserId: "owner",
    });

    // Criterion 5 at the database level: the first row was not mutated or removed.
    const rows = await testDb
      .select()
      .from(schema.variantCost)
      .where(eq(schema.variantCost.variantId, V1))
      .orderBy(asc(schema.variantCost.effectiveFrom));
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(original.id);
    expect(rows[0].unitCostCents).toBe(800);
    expect(rows[0].note).toBeNull();
    expect(rows[1].unitCostCents).toBe(950);

    const before = await resolveVariantCostAt(V1, new Date("2026-04-15T00:00:00.000Z"));
    expect(before?.id).toBe(original.id);
    expect(before?.unitCostCents).toBe(800);
  });

  it("resolves many variants in one pass, with null where no cost is in force", async () => {
    const { resolveVariantCostsAt } = await import("./store");
    await seedCost({ variantId: V1, unitCostCents: 800 });
    await seedCost({
      variantId: V2,
      unitCostCents: 1200,
      effectiveFrom: new Date("2027-01-01T00:00:00.000Z"), // future-dated
    });

    const resolved = await resolveVariantCostsAt(
      [V1, V2, V3],
      new Date("2026-09-09T00:00:00.000Z"),
    );
    expect(resolved.get(V1)?.unitCostCents).toBe(800);
    expect(resolved.get(V2)).toBeNull(); // scheduled, not yet in force
    expect(resolved.get(V3)).toBeNull(); // never priced
    expect(resolved.size).toBe(3);
  });

  it("resolves nothing for an empty variant list without querying", async () => {
    const { costsForVariants, resolveVariantCostsAt } = await import("./store");
    expect((await costsForVariants([])).size).toBe(0);
    expect((await resolveVariantCostsAt([], new Date())).size).toBe(0);
  });

  it("lists a variant's full history newest effective date first", async () => {
    const { costHistoryForVariant } = await import("./store");
    await seedCost({ unitCostCents: 800, effectiveFrom: new Date("2026-03-01T00:00:00.000Z") });
    await seedCost({ unitCostCents: 950, effectiveFrom: new Date("2026-06-01T00:00:00.000Z") });
    await seedCost({ unitCostCents: 700, effectiveFrom: new Date("2026-01-01T00:00:00.000Z") });

    const history = await costHistoryForVariant(V1);
    expect(history.map((c) => c.unitCostCents)).toEqual([950, 800, 700]);
  });
});

/**
 * Criterion 5 as an enforced invariant rather than a naming convention: for the
 * duration of these cases Postgres itself rejects any UPDATE or DELETE of a
 * cost row, so a write path that mutates history throws instead of passing
 * quietly — whether it goes through drizzle, a transaction, or raw SQL.
 */
async function withAppendOnlyEnforced<T>(fn: () => Promise<T>): Promise<T> {
  await client.exec(`CREATE FUNCTION variant_cost_guard() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'variant_cost is append-only: % rejected', TG_OP; END;
    $$ LANGUAGE plpgsql;`);
  await client.exec(`CREATE TRIGGER variant_cost_guard BEFORE UPDATE OR DELETE ON variant_cost
    FOR EACH ROW EXECUTE FUNCTION variant_cost_guard();`);
  try {
    return await fn();
  } finally {
    await client.exec(
      "DROP TRIGGER variant_cost_guard ON variant_cost; DROP FUNCTION variant_cost_guard();",
    );
  }
}

describe("cost history is append-only", () => {
  /** Drizzle wraps the database error, so look down the whole cause chain. */
  async function expectBlockedByGuard(work: Promise<unknown>) {
    let reason = "";
    await work.then(
      () => {
        throw new Error("Expected the append-only guard to reject this write");
      },
      (err: unknown) => {
        for (let e: unknown = err; e instanceof Error; e = e.cause) reason += `${e.message}\n`;
      },
    );
    expect(reason).toMatch(/variant_cost is append-only/);
  }

  it("has a guard that actually bites", async () => {
    const seeded = await seedCost();
    await withAppendOnlyEnforced(async () => {
      await expectBlockedByGuard(
        testDb
          .update(schema.variantCost)
          .set({ unitCostCents: 1 })
          .where(eq(schema.variantCost.id, seeded.id)),
      );
      await expectBlockedByGuard(
        testDb.delete(schema.variantCost).where(eq(schema.variantCost.id, seeded.id)),
      );
    });
    const [row] = await testDb.select().from(schema.variantCost);
    expect(row).toEqual(seeded);
  });

  it("survives every path the cost store and the write route expose", async () => {
    const costStore = await import("./store");
    const { POST } = await import("@/app/api/costs/route");
    const seeded = await seedCost({ unitCostCents: 800, note: "opening quote" });

    // Each export gets exercised under the guard. The equality check is what
    // stops a newly added export from slipping past unexercised.
    const exercise: Record<string, () => Promise<unknown>> = {
      listCatalog: () =>
        costStore.listCatalog({
          connectionId: ownerConnectionId,
          q: "alpha",
          limit: 20,
          offset: 0,
        }),
      costHistoryForVariant: () => costStore.costHistoryForVariant(V1),
      costsForVariants: () => costStore.costsForVariants([V1, V2]),
      resolveVariantCostAt: () => costStore.resolveVariantCostAt(V1, new Date()),
      resolveVariantCostsAt: () => costStore.resolveVariantCostsAt([V1, V2], new Date()),
      insertVariantCost: () =>
        costStore.insertVariantCost({
          variantId: V1,
          unitCostCents: 950,
          currency: "USD",
          effectiveFrom: new Date("2026-06-01T00:00:00.000Z"),
          createdByUserId: "owner",
        }),
      variantOwnedByUser: () => costStore.variantOwnedByUser("owner", V1),
    };
    expect(Object.keys(costStore).sort()).toEqual(Object.keys(exercise).sort());

    await withAppendOnlyEnforced(async () => {
      for (const run of Object.values(exercise)) await run();
      // The only writer the UI has, including a second cost for a date the
      // first one already covers — the "edit" case.
      for (const unitCost of ["9.99", "10.50"]) {
        const res = await POST(
          costRequest({ variantId: V1, unitCost, effectiveFrom: "2026-03-01" }),
        );
        expect(res.status).toBe(201);
      }
    });

    // The row that was there first is byte-for-byte the row that is there now.
    const [oldest] = await testDb
      .select()
      .from(schema.variantCost)
      .where(eq(schema.variantCost.id, seeded.id));
    expect(oldest).toEqual(seeded);
    expect(await testDb.select().from(schema.variantCost)).toHaveLength(4);
  });
});

describe("listCatalog", () => {
  it("lists live products with their variants, ordered by title then position", async () => {
    const { listCatalog } = await import("./store");
    const { products, hasMore } = await listCatalog({
      connectionId: ownerConnectionId,
      limit: 20,
      offset: 0,
    });

    expect(products.map((p) => p.product.title)).toEqual(["Alpha Tee", "Beta Hoodie"]);
    expect(hasMore).toBe(false);
    expect(products[0].variants.map((v) => v.id)).toEqual([V1, V2]);
    expect(products[1].variants[0].sku).toBeNull(); // a variant may have no SKU
  });

  it("hides soft-deleted products and other users' products", async () => {
    const { listCatalog } = await import("./store");
    const { products } = await listCatalog({
      connectionId: ownerConnectionId,
      limit: 20,
      offset: 0,
    });
    const ids = products.map((p) => p.product.id);
    expect(ids).not.toContain(P3); // deleted upstream
    expect(ids).not.toContain(P9); // another connection
  });

  it("hides a soft-deleted variant while keeping its product", async () => {
    const { listCatalog } = await import("./store");
    await testDb
      .update(schema.shopifyVariant)
      .set({ deletedAt: SYNCED })
      .where(eq(schema.shopifyVariant.id, V2));

    const { products } = await listCatalog({
      connectionId: ownerConnectionId,
      limit: 20,
      offset: 0,
    });
    const alpha = products.find((p) => p.product.id === P1)!;
    expect(alpha.variants.map((v) => v.id)).toEqual([V1]);
  });

  it("searches product title, handle and variant SKU", async () => {
    const { listCatalog } = await import("./store");
    const byTitle = await listCatalog({
      connectionId: ownerConnectionId,
      q: "hoodie",
      limit: 20,
      offset: 0,
    });
    expect(byTitle.products.map((p) => p.product.id)).toEqual([P2]);

    const byHandle = await listCatalog({
      connectionId: ownerConnectionId,
      q: "alpha-t",
      limit: 20,
      offset: 0,
    });
    expect(byHandle.products.map((p) => p.product.id)).toEqual([P1]);

    const bySku = await listCatalog({
      connectionId: ownerConnectionId,
      q: "ALPHA-L",
      limit: 20,
      offset: 0,
    });
    expect(bySku.products.map((p) => p.product.id)).toEqual([P1]);

    const nothing = await listCatalog({
      connectionId: ownerConnectionId,
      q: "no-such-thing",
      limit: 20,
      offset: 0,
    });
    expect(nothing.products).toEqual([]);
    expect(nothing.hasMore).toBe(false);
  });

  it("pages with hasMore rather than a count query", async () => {
    const { listCatalog } = await import("./store");
    const first = await listCatalog({ connectionId: ownerConnectionId, limit: 1, offset: 0 });
    expect(first.products.map((p) => p.product.title)).toEqual(["Alpha Tee"]);
    expect(first.hasMore).toBe(true);

    const second = await listCatalog({ connectionId: ownerConnectionId, limit: 1, offset: 1 });
    expect(second.products.map((p) => p.product.title)).toEqual(["Beta Hoodie"]);
    expect(second.hasMore).toBe(false);
  });
});

describe("variantOwnedByUser", () => {
  it("returns the variant with its product and connection for the owner", async () => {
    const { variantOwnedByUser } = await import("./store");
    const owned = await variantOwnedByUser("owner", V1);
    expect(owned?.variant.id).toBe(V1);
    expect(owned?.product.title).toBe("Alpha Tee");
    expect(owned?.connection.id).toBe(ownerConnectionId);
  });

  it("returns null for another user's variant and for one that does not exist", async () => {
    const { variantOwnedByUser } = await import("./store");
    expect(await variantOwnedByUser("owner", V9)).toBeNull();
    expect(await variantOwnedByUser("owner", "gid://shopify/ProductVariant/nope")).toBeNull();
  });
});

describe("POST /api/costs", () => {
  it("rejects an unauthenticated caller", async () => {
    const { POST } = await import("@/app/api/costs/route");
    state.userId = null;
    const res = await POST(
      costRequest({ variantId: V1, unitCost: "12.34", effectiveFrom: "2026-07-01" }),
    );
    expect(res.status).toBe(401);
    expect(await testDb.select().from(schema.variantCost)).toHaveLength(0);
  });

  it("stores a decimal cost as integer cents with the connection's currency", async () => {
    const { POST } = await import("@/app/api/costs/route");
    const res = await POST(
      costRequest({
        variantId: V1,
        unitCost: "12.34",
        effectiveFrom: "2026-07-01",
        note: "  first supplier quote  ",
      }),
    );
    expect(res.status).toBe(201);
    const { cost } = await res.json();
    expect(cost.unitCostCents).toBe(1234);

    const [row] = await testDb.select().from(schema.variantCost);
    expect(row.unitCostCents).toBe(1234);
    expect(Number.isInteger(row.unitCostCents)).toBe(true);
    expect(row.currency).toBe("USD");
    expect(row.note).toBe("first supplier quote");
    expect(row.createdByUserId).toBe("owner");
  });

  it("converts every decimal to exact cents, including those float math gets wrong", async () => {
    const { POST } = await import("@/app/api/costs/route");
    // "12.34" alone proves nothing: parseFloat("12.34") * 100 is exactly 1234,
    // and so is parseFloat("8.15") * 100. The ones that catch float math are
    // "0.07" (7.000000000000001), "0.29" (28.999999999999996) and "1.10"
    // (110.00000000000001): non-integers that the integer column rejects, and
    // a cent out if truncated. Rounding those would still land right, so what
    // stops a third decimal place is decimalToCents' format check — pinned by
    // "rejects a cost with more than two decimal places" below, not here.
    const expected: Record<string, number> = {
      "0.07": 7,
      "0.29": 29,
      "1.10": 110,
      "8.15": 815,
      "12.34": 1234,
      "99999.99": 9999999,
    };
    for (const unitCost of Object.keys(expected)) {
      const res = await POST(
        costRequest({ variantId: V1, unitCost, effectiveFrom: "2026-07-01", note: unitCost }),
      );
      expect(res.status).toBe(201);
      expect((await res.json()).cost.unitCostCents).toBe(expected[unitCost]);
    }

    const rows = await testDb.select().from(schema.variantCost);
    expect(Object.fromEntries(rows.map((r) => [r.note, r.unitCostCents]))).toEqual(expected);
    for (const row of rows) expect(Number.isInteger(row.unitCostCents)).toBe(true);
  });

  it("accepts a zero cost, which is a real cost and not a missing one", async () => {
    const { POST } = await import("@/app/api/costs/route");
    const { resolveVariantCostAt } = await import("./store");
    const res = await POST(
      costRequest({ variantId: V1, unitCost: "0", effectiveFrom: "2026-07-01" }),
    );
    expect(res.status).toBe(201);
    const resolved = await resolveVariantCostAt(V1, new Date("2026-08-01T00:00:00.000Z"));
    expect(resolved).not.toBeNull();
    expect(resolved?.unitCostCents).toBe(0);
  });

  it("rejects a cost with more than two decimal places", async () => {
    const { POST } = await import("@/app/api/costs/route");
    const res = await POST(
      costRequest({ variantId: V1, unitCost: "12.345", effectiveFrom: "2026-07-01" }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/12\.34/);
    expect(await testDb.select().from(schema.variantCost)).toHaveLength(0);
  });

  it("rejects a negative cost", async () => {
    const { POST } = await import("@/app/api/costs/route");
    const res = await POST(
      costRequest({ variantId: V1, unitCost: "-1.00", effectiveFrom: "2026-07-01" }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/negative/i);
    expect(await testDb.select().from(schema.variantCost)).toHaveLength(0);
  });

  it("rejects an implausibly large cost", async () => {
    const { POST } = await import("@/app/api/costs/route");
    const res = await POST(
      costRequest({ variantId: V1, unitCost: "100000.01", effectiveFrom: "2026-07-01" }),
    );
    expect(res.status).toBe(400);
    expect(await testDb.select().from(schema.variantCost)).toHaveLength(0);
  });

  it("rejects a malformed effective date", async () => {
    const { POST } = await import("@/app/api/costs/route");
    const res = await POST(
      costRequest({ variantId: V1, unitCost: "12.34", effectiveFrom: "01/07/2026" }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/YYYY-MM-DD/);
  });

  it("rejects a note longer than 200 characters", async () => {
    const { POST } = await import("@/app/api/costs/route");
    const res = await POST(
      costRequest({
        variantId: V1,
        unitCost: "12.34",
        effectiveFrom: "2026-07-01",
        note: "x".repeat(201),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("404s on a variant the caller does not own, without writing anything", async () => {
    const { POST } = await import("@/app/api/costs/route");
    const res = await POST(
      costRequest({ variantId: V9, unitCost: "12.34", effectiveFrom: "2026-07-01" }),
    );
    expect(res.status).toBe(404);
    expect(await testDb.select().from(schema.variantCost)).toHaveLength(0);
  });

  it("has no update, patch or delete handler", async () => {
    const route = await import("@/app/api/costs/route");
    expect(Object.keys(route)).toEqual(["POST"]);
  });

  it("re-entering a cost adds a row instead of replacing the first", async () => {
    const { POST } = await import("@/app/api/costs/route");
    await POST(costRequest({ variantId: V1, unitCost: "8.00", effectiveFrom: "2026-03-01" }));
    await POST(costRequest({ variantId: V1, unitCost: "9.50", effectiveFrom: "2026-06-01" }));

    const rows = await testDb
      .select()
      .from(schema.variantCost)
      .orderBy(asc(schema.variantCost.effectiveFrom));
    expect(rows.map((r) => r.unitCostCents)).toEqual([800, 950]);
  });
});

describe("effective dates are shop-local", () => {
  it("stores midnight in the shop's timezone, not UTC midnight", async () => {
    const { POST } = await import("@/app/api/costs/route");
    await POST(costRequest({ variantId: V1, unitCost: "9.50", effectiveFrom: "2026-07-01" }));

    const [row] = await testDb.select().from(schema.variantCost);
    // Los Angeles is UTC-7 on 1 July.
    expect(row.effectiveFrom.toISOString()).toBe("2026-07-01T07:00:00.000Z");
  });

  it("gives a UTC-less shop a different instant for the same date", async () => {
    const { POST } = await import("@/app/api/costs/route");
    await POST(costRequest({ variantId: V1, unitCost: "9.50", effectiveFrom: "2026-07-01" }));
    state.userId = "intruder";
    await POST(costRequest({ variantId: V9, unitCost: "9.50", effectiveFrom: "2026-07-01" }));

    const [pacific] = await testDb
      .select()
      .from(schema.variantCost)
      .where(eq(schema.variantCost.variantId, V1));
    const [utc] = await testDb
      .select()
      .from(schema.variantCost)
      .where(eq(schema.variantCost.variantId, V9));
    expect(utc.effectiveFrom.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(pacific.effectiveFrom.getTime()).not.toBe(utc.effectiveFrom.getTime());
    expect(pacific.effectiveFrom.getTime() - utc.effectiveFrom.getTime()).toBe(7 * 60 * 60 * 1000);
  });

  it("holds the old cost through the shop's evening on the day before", async () => {
    const { POST } = await import("@/app/api/costs/route");
    const { resolveVariantCostAt } = await import("./store");
    await POST(costRequest({ variantId: V1, unitCost: "8.00", effectiveFrom: "2026-06-01" }));
    await POST(costRequest({ variantId: V1, unitCost: "9.50", effectiveFrom: "2026-07-01" }));

    // 30 June, 20:00 in Los Angeles — already 1 July in UTC. Reading the date as
    // UTC midnight would have charged this order the new cost eight hours early.
    const shopEvening = await resolveVariantCostAt(V1, new Date("2026-07-01T03:00:00.000Z"));
    expect(shopEvening?.unitCostCents).toBe(800);
    // 00:30 on 1 July in Los Angeles: the new cost is in force.
    const shopMorning = await resolveVariantCostAt(V1, new Date("2026-07-01T07:30:00.000Z"));
    expect(shopMorning?.unitCostCents).toBe(950);
  });
});
