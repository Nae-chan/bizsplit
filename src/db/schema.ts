import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Chunk 0 placeholder table: proves migrations run end-to-end on Render.
 * Real domain tables (accounts, partnerships, agreements, ledger) arrive in Chunks 1-6.
 */
export const appMeta = pgTable("app_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
