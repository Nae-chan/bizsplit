import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, ilike, inArray, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { shopifyProduct, shopifyVariant, storeConnection, variantCost } from "@/db/schema";
import { resolveCostAt, type EffectiveCost } from "@/lib/cogs/resolve";

/**
 * Database accessors for the catalog and its costs. Split from resolve.ts the
 * way store.ts is split from mapping.ts: the rules are pure over there, the
 * queries live here. Chunk 5 consumes resolveVariantCostAt /
 * resolveVariantCostsAt.
 *
 * Costs are append-only (criterion 5): this module deliberately exposes no
 * update and no delete. "Editing" a cost is another insertVariantCost.
 */

export interface CatalogProduct {
  product: typeof shopifyProduct.$inferSelect;
  variants: Array<typeof shopifyVariant.$inferSelect>;
}

/**
 * One page of the catalog: live products (soft-deleted ones are hidden) with
 * their live variants. `q` matches a product title or handle, or a variant SKU.
 * `hasMore` says whether another page exists, so the UI can offer "Next".
 */
export async function listCatalog(opts: {
  connectionId: string;
  q?: string;
  limit: number;
  offset: number;
}): Promise<{ products: CatalogProduct[]; hasMore: boolean }> {
  const q = opts.q?.trim();
  const like = q ? `%${q}%` : null;
  const matchesQuery = like
    ? or(
        ilike(shopifyProduct.title, like),
        ilike(shopifyProduct.handle, like),
        inArray(
          shopifyProduct.id,
          db
            .select({ id: shopifyVariant.productId })
            .from(shopifyVariant)
            .where(and(isNull(shopifyVariant.deletedAt), ilike(shopifyVariant.sku, like))),
        ),
      )
    : undefined;

  // One extra row tells us whether there is a next page without a count query.
  const rows = await db
    .select()
    .from(shopifyProduct)
    .where(
      and(
        eq(shopifyProduct.connectionId, opts.connectionId),
        isNull(shopifyProduct.deletedAt),
        matchesQuery,
      ),
    )
    .orderBy(asc(shopifyProduct.title), asc(shopifyProduct.id))
    .limit(opts.limit + 1)
    .offset(opts.offset);

  const page = rows.slice(0, opts.limit);
  if (page.length === 0) return { products: [], hasMore: false };

  const variants = await db
    .select()
    .from(shopifyVariant)
    .where(
      and(
        inArray(
          shopifyVariant.productId,
          page.map((p) => p.id),
        ),
        isNull(shopifyVariant.deletedAt),
      ),
    )
    .orderBy(asc(shopifyVariant.position), asc(shopifyVariant.id));

  return {
    products: page.map((product) => ({
      product,
      variants: variants.filter((v) => v.productId === product.id),
    })),
    hasMore: rows.length > opts.limit,
  };
}

/** Full cost history for one variant, newest effective date first. */
export async function costHistoryForVariant(variantId: string) {
  return db
    .select()
    .from(variantCost)
    .where(eq(variantCost.variantId, variantId))
    .orderBy(desc(variantCost.effectiveFrom), desc(variantCost.createdAt));
}

/**
 * Every cost row for a set of variants, grouped by variant. One query, grouped
 * in JS — fine at Chunk 3 volumes; a DISTINCT ON pass is deferred.
 */
export async function costsForVariants(
  variantIds: string[],
): Promise<Map<string, EffectiveCost[]>> {
  const grouped = new Map<string, EffectiveCost[]>();
  if (variantIds.length === 0) return grouped;
  const rows = await db
    .select()
    .from(variantCost)
    .where(inArray(variantCost.variantId, variantIds));
  for (const row of rows) {
    const bucket = grouped.get(row.variantId);
    if (bucket) bucket.push(row);
    else grouped.set(row.variantId, [row]);
  }
  return grouped;
}

/**
 * The cost in force for one variant at an instant — for an order, its
 * `placed_at`. `null` means no cost is in force, which is not a cost of zero.
 */
export async function resolveVariantCostAt(variantId: string, at: Date) {
  return resolveCostAt(await costHistoryForVariant(variantId), at);
}

/** The same, for many variants at once. Variants with no cost in force map to null. */
export async function resolveVariantCostsAt(variantIds: string[], at: Date) {
  const grouped = await costsForVariants(variantIds);
  const resolved = new Map<string, EffectiveCost | null>();
  for (const id of variantIds) {
    resolved.set(id, resolveCostAt(grouped.get(id) ?? [], at));
  }
  return resolved;
}

/** Append a cost. There is no update path: correcting a cost adds another row. */
export async function insertVariantCost(input: {
  variantId: string;
  unitCostCents: number;
  currency: string;
  effectiveFrom: Date;
  note?: string | null;
  createdByUserId: string | null;
}) {
  const [created] = await db
    .insert(variantCost)
    .values({
      id: randomUUID(),
      variantId: input.variantId,
      unitCostCents: input.unitCostCents,
      currency: input.currency,
      effectiveFrom: input.effectiveFrom,
      note: input.note ?? null,
      createdByUserId: input.createdByUserId,
    })
    .returning();
  return created;
}

/**
 * The variant with its product and owning connection, but only if the caller
 * owns it. Null is a 404 for the API route and the detail page — the same
 * answer as a variant that does not exist, so ownership is not probeable.
 */
export async function variantOwnedByUser(userId: string, variantId: string) {
  const rows = await db
    .select({
      variant: shopifyVariant,
      product: shopifyProduct,
      connection: storeConnection,
    })
    .from(shopifyVariant)
    .innerJoin(shopifyProduct, eq(shopifyVariant.productId, shopifyProduct.id))
    .innerJoin(storeConnection, eq(shopifyProduct.connectionId, storeConnection.id))
    .where(and(eq(shopifyVariant.id, variantId), eq(storeConnection.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}
