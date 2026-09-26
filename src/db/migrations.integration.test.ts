import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Migrations applied to a database that already holds data, rather than to the
 * empty one every other integration test replays them into. That is the only
 * way the destructive shapes show up: a DROP + ADD instead of a RENAME reads as
 * a clean migration against an empty database and silently resets live data.
 */

const dir = path.resolve(__dirname, "../../drizzle");

function migrationFiles() {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

async function apply(client: PGlite, file: string) {
  for (const stmt of readFileSync(path.join(dir, file), "utf8").split("--> statement-breakpoint")) {
    if (stmt.trim()) await client.exec(stmt);
  }
}

describe("0003 products/cogs migration", () => {
  it("renames orders_synced to items_synced, keeping in-flight job progress", async () => {
    const client = new PGlite();
    const files = migrationFiles();
    const zeroThree = files.find((f) => f.startsWith("0003"))!;
    for (const file of files.filter((f) => f < zeroThree)) await apply(client, file);

    // A backfill that was half-way through when the deploy happened.
    await client.exec(`
      INSERT INTO "user" ("id", "name", "email") VALUES ('user-1', 'Nae', 'nae@example.com');
      INSERT INTO "store_connection"
        ("id", "user_id", "shop_domain", "shop_name", "encrypted_client_id",
         "encrypted_client_secret", "currency")
        VALUES ('conn-1', 'user-1', 'ripright.myshopify.com', 'Ripright', 'enc-id', 'enc-secret', 'USD');
      INSERT INTO "sync_job"
        ("id", "connection_id", "start_date", "cursor", "status", "orders_synced")
        VALUES ('job-1', 'conn-1', '2026-01-01T00:00:00Z', 'cursor-page-37', 'running', 1850);
    `);

    await apply(client, zeroThree);

    const { rows } = await client.query<{
      items_synced: number;
      cursor: string;
      status: string;
      kind: string;
    }>(`SELECT "items_synced", "cursor", "status", "kind" FROM "sync_job" WHERE "id" = 'job-1'`);
    expect(rows).toHaveLength(1);
    // A DROP + ADD would have reset this to the column default of 0 and made
    // the resumed backfill re-report 1850 orders as unsynced.
    expect(rows[0].items_synced).toBe(1850);
    expect(rows[0].cursor).toBe("cursor-page-37");
    expect(rows[0].status).toBe("running");
    // Jobs that predate the catalog sync are order jobs.
    expect(rows[0].kind).toBe("orders");

    const columns = await client.query<{ column_name: string }>(
      `SELECT "column_name" FROM information_schema.columns WHERE table_name = 'sync_job'`,
    );
    const names = columns.rows.map((r) => r.column_name);
    expect(names).toContain("items_synced");
    expect(names).not.toContain("orders_synced");
  });

  it("does not contain SQL that PGlite (and so the migration replay) cannot run", async () => {
    // Every integration test replays these files, so anything Postgres-only
    // like CREATE INDEX CONCURRENTLY would break the whole suite.
    const client = new PGlite();
    for (const file of migrationFiles()) await apply(client, file);
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.tables WHERE table_name IN ('shopify_product', 'shopify_variant', 'variant_cost')`,
    );
    expect(rows[0].count).toBe("3");
  });
});
