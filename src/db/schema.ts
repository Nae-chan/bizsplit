import { boolean, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Chunk 0 placeholder table: proves migrations run end-to-end on Render.
 */
export const appMeta = pgTable("app_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Auth tables (better-auth). One account type for everyone (ADR-0002):
 * "user" is the person; "account" below is better-auth's credential store
 * (password / future OAuth providers), not a BizSplit business concept.
 */
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  brandName: text("brand_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull().unique(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Store connections (Chunk 2). Internal-first approach (approved 2026-07-08),
 * updated for Shopify's 2026-01-01 removal of legacy custom apps: users paste
 * their Dev Dashboard app's client ID + secret, and BizSplit exchanges them
 * for short-lived access tokens (client credentials grant, ADR-0006).
 * All credentials are encrypted at rest (AES-256-GCM, src/lib/crypto.ts).
 */
export const storeConnection = pgTable("store_connection", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  shopDomain: text("shop_domain").notNull().unique(),
  shopName: text("shop_name").notNull(),
  /** Dev Dashboard app credentials (client credentials grant, ADR-0006). */
  encryptedClientId: text("encrypted_client_id").notNull(),
  encryptedClientSecret: text("encrypted_client_secret").notNull(),
  /** Cached short-lived (~24h) access token; refreshed on demand. */
  encryptedAccessToken: text("encrypted_access_token"),
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
  currency: text("currency").notNull(),
  /** Shop's IANA timezone (e.g. "America/New_York"); null for pre-Chunk-3 connections. */
  ianaTimezone: text("iana_timezone"),
  status: text("status", { enum: ["active", "disconnected"] })
    .notNull()
    .default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Orders synced from Shopify. All money in integer cents (ADR-0004). */
export const shopifyOrder = pgTable("shopify_order", {
  id: text("id").primaryKey(), // Shopify order GID
  connectionId: text("connection_id")
    .notNull()
    .references(() => storeConnection.id, { onDelete: "cascade" }),
  orderNumber: text("order_number").notNull(),
  placedAt: timestamp("placed_at", { withTimezone: true }).notNull(),
  currency: text("currency").notNull(),
  subtotalCents: integer("subtotal_cents").notNull(),
  discountsCents: integer("discounts_cents").notNull().default(0),
  shippingCents: integer("shipping_cents").notNull().default(0),
  taxCents: integer("tax_cents").notNull().default(0),
  totalCents: integer("total_cents").notNull(),
  /** Actual gateway fees; null until Shopify reports them (ADR-0005). */
  feesCents: integer("fees_cents"),
  financialStatus: text("financial_status").notNull(),
  shopifyUpdatedAt: timestamp("shopify_updated_at", { withTimezone: true }).notNull(),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
});

export const shopifyOrderLine = pgTable("shopify_order_line", {
  id: text("id").primaryKey(), // Shopify line item GID
  orderId: text("order_id")
    .notNull()
    .references(() => shopifyOrder.id, { onDelete: "cascade" }),
  productId: text("product_id"),
  variantId: text("variant_id"),
  title: text("title").notNull(),
  quantity: integer("quantity").notNull(),
  unitPriceCents: integer("unit_price_cents").notNull(),
  discountedTotalCents: integer("discounted_total_cents").notNull(),
});

/**
 * Resumable backfill (runs page-by-page; no worker needed yet). One row per
 * job, shared by the order backfill and the Chunk 3 catalog sync: `kind`
 * says which, and `start_date` is the "since" floor (null = full sync).
 */
export const syncJob = pgTable("sync_job", {
  id: text("id").primaryKey(),
  connectionId: text("connection_id")
    .notNull()
    .references(() => storeConnection.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["orders", "products"] })
    .notNull()
    .default("orders"),
  startDate: timestamp("start_date", { withTimezone: true }),
  cursor: text("cursor"),
  status: text("status", { enum: ["running", "completed", "failed"] })
    .notNull()
    .default("running"),
  itemsSynced: integer("items_synced").notNull().default(0),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Product catalog synced from Shopify (Chunk 3). Every status syncs (active,
 * draft, archived) because orders can reference variants of archived products;
 * the browse UI filters. Rows are never deleted — `deleted_at` is a soft
 * delete, because variant cost history hangs off variants.
 */
export const shopifyProduct = pgTable(
  "shopify_product",
  {
    id: text("id").primaryKey(), // Shopify product GID
    connectionId: text("connection_id")
      .notNull()
      .references(() => storeConnection.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    handle: text("handle").notNull(),
    /** Shopify's ACTIVE / ARCHIVED / DRAFT, stored verbatim. */
    status: text("status").notNull(),
    productType: text("product_type"),
    vendor: text("vendor"),
    imageUrl: text("image_url"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    shopifyUpdatedAt: timestamp("shopify_updated_at", { withTimezone: true }).notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("shopify_product_connection_id_idx").on(t.connectionId)],
);

export const shopifyVariant = pgTable(
  "shopify_variant",
  {
    id: text("id").primaryKey(), // Shopify variant GID
    productId: text("product_id")
      .notNull()
      .references(() => shopifyProduct.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    sku: text("sku"),
    position: integer("position").notNull().default(1),
    /** Selling price in integer cents (ADR-0004). */
    priceCents: integer("price_cents").notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    shopifyUpdatedAt: timestamp("shopify_updated_at", { withTimezone: true }).notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("shopify_variant_product_id_idx").on(t.productId)],
);

/**
 * Cost of goods per variant, effective-dated and append-only: editing a cost
 * inserts another row, so an order always resolves to the cost in force when
 * it was placed. Deliberately has no updated_at and no update path.
 */
export const variantCost = pgTable(
  "variant_cost",
  {
    id: text("id").primaryKey(),
    variantId: text("variant_id")
      .notNull()
      .references(() => shopifyVariant.id, { onDelete: "cascade" }),
    unitCostCents: integer("unit_cost_cents").notNull(),
    currency: text("currency").notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    note: text("note"),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("variant_cost_variant_id_effective_from_idx").on(t.variantId, t.effectiveFrom)],
);
