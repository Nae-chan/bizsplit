import { boolean, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

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

/** Resumable historical backfill (runs page-by-page; no worker needed yet). */
export const syncJob = pgTable("sync_job", {
  id: text("id").primaryKey(),
  connectionId: text("connection_id")
    .notNull()
    .references(() => storeConnection.id, { onDelete: "cascade" }),
  startDate: timestamp("start_date", { withTimezone: true }).notNull(),
  cursor: text("cursor"),
  status: text("status", { enum: ["running", "completed", "failed"] })
    .notNull()
    .default("running"),
  ordersSynced: integer("orders_synced").notNull().default(0),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
