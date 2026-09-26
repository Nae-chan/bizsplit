# Chunk 3 — Products & COGS: catalog sync, in-app costs with effective dates

> There is no existing plans convention in this repo (`docs/` contains only `adr/`), so this plan
> lives at `docs/plans/chunk-3-products-cogs.md`. Branch: `chunk-3-products-cogs`.

## Decisions (settled before implementation — these supersede the open questions below)

1. **Effective dates are interpreted in the shop's local timezone, not UTC.** Add
   `iana_timezone` (text, nullable) to `store_connection`, populated from the Shopify shop's
   `ianaTimezone` when a store connects and refreshed on catalog sync. A date entered as
   `2026-07-01` means midnight of that date in the shop's zone, converted to an instant for
   storage in `effective_from`. When `iana_timezone` is null (a connection made before this
   chunk, not yet refreshed), fall back to UTC. Resolution still compares absolute instants,
   so the resolver itself is unchanged — only the date-to-instant conversion moves.
2. **No product-level default cost.** Costs are per variant, as the criteria state.
3. **Costs stay scoped to the connection** via the variant. Duplicated costs across two stores
   selling the same SKU are acceptable for now.
4. **Sync every product status**, store `status`, and filter in the browse UI. Orders can
   reference variants of archived products.
5. **Cost currency is inherited from the connection**, not user-selectable. ADR-0004 makes
   cross-currency arithmetic throw and there is no FX story yet.

## Goal

Sync the connected Shopify store's product catalog (products + variants) into BizSplit, one
resumable page at a time, and let the user record a cost of goods per variant in integer cents with
an effective date. Cost history is append-only: editing a cost adds a new effective-dated record,
and any past order resolves to the cost that was in force on the date it was placed. Ship a UI to
browse the catalog and set/edit costs. Chunk 5's split engine consumes the resolver this chunk
exposes; this chunk does no split math.

## Acceptance criteria

1. The product catalog syncs from the connected Shopify store, covering products and their variants,
   and can be brought current again after products change upstream (re-sync and/or webhook).
2. Catalog sync is resumable a page at a time, driven by HTTP requests from the browser with no
   background worker and no long-running request — the same constraint the order backfill was built
   under (Render free web tier). Interrupting the sync and resuming it later loses no progress.
3. A cost of goods can be entered per variant and is stored as integer cents plus a currency code
   (ADR-0004). No float is persisted.
4. Costs carry an effective date. Resolving the cost for an order uses the order's `placed_at`, not
   the current date: an order placed in the past resolves to the cost in force then.
5. Editing a cost inserts a new effective-dated row; no existing cost row is mutated or deleted.
   After an edit, an order placed before the new effective date still resolves to the older cost.
6. There is a UI that lists synced products and variants with each variant's current cost, and a
   screen to add a cost and view a variant's full cost history.
7. Unit tests cover cost resolution by date, including: an order dated before any cost exists
   (resolves to "no cost in force", not zero), an order dated exactly on an effective date (resolves
   to that cost), and an order dated between two effective dates (resolves to the earlier one).
8. An integration test exercises catalog sync against in-memory Postgres (PGlite) with a mocked
   Shopify GraphQL API, in the style of `src/lib/shopify/sync.integration.test.ts`: paged sync,
   progress tracking, idempotent re-sync, and API failure marking the job failed.
9. `npm run verify` passes (typecheck, lint, format check, full test suite).

## Current state

Everything below was read on this branch.

**Schema** (`src/db/schema.ts`)

- `storeConnection` (lines 75-94): one active connection per user; `currency` (line 88) is the shop
  currency; credentials encrypted (ADR-0006).
- `shopifyOrder` (97-115) and `shopifyOrderLine` (117-128). Order lines already carry
  `productId`/`variantId` as nullable Shopify GIDs (122-123) with **no** foreign key to a catalog —
  they are free-floating GID strings today.
- `syncJob` (131-145): order-backfill state. `startDate` is `NOT NULL` (136), the counter column is
  `ordersSynced` (141), status enum `running | completed | failed` (138-140). There is no `kind`
  column — the table assumes one job type.
- Conventions: `text` primary keys (Shopify GID for synced rows, `randomUUID()` for BizSplit rows),
  `timestamp with time zone`, money as `integer` `*_cents` columns, no indexes declared anywhere,
  enums expressed as `text(..., { enum: [...] })`.

**Shopify library** (`src/lib/shopify/`)

- `client.ts`: `shopifyGraphql<T>(shopDomain, token, query, variables)` (17-42), `ShopifyApiError`
  with `status` (7-15), API version `2026-04` (line 5). No SDK, plain `fetch`.
- `queries.ts`: `SHOP_QUERY`, `ORDERS_PAGE_QUERY` (11-85, `first`/`after`/`query` + `pageInfo`),
  `WEBHOOK_CREATE_MUTATION` (87-102).
- `mapping.ts`: `ShopifyOrderNode` types (4-35), `MappedOrder` (37-61), `extractFeesCents` (68-75),
  `mapOrderNode` (77-104). All money converted with `decimalToCents`.
- `store.ts`: `getConnectionForUser` (12-19), `createConnection` (21-52), `getAccessToken` (60-82,
  the only sanctioned token path per ADR-0006), `upsertMappedOrder` (84-115, `onConflictDoUpdate`
  idempotency), `runSyncStep` (118-171, one 50-order page per call, cursor + counter persisted, API
  errors caught and written to `syncJob.status = "failed"`), `latestSyncJob` (173-181, latest job for
  a connection, no kind filter). `PAGE_SIZE = 50` (line 10).
- `sync.integration.test.ts`: PGlite + `drizzle-orm/pglite`, `vi.mock("@/db")` returning the test db
  (18-22), migrations replayed by reading every `drizzle/*.sql` sorted and splitting on
  `--> statement-breakpoint` (72-82), `global.fetch` mocked with queued token/GraphQL responses
  (59-70), dynamic `await import("./store")` inside each test so the db mock is in place.

**Sync driving** (no background worker)

- `src/app/api/store/sync-step/route.ts`: session check, `bodySchema = { jobId }`, ownership check
  that compares the posted `jobId` to `latestSyncJob(conn.id)` (17-21) — this breaks as soon as a
  connection has two concurrent jobs of different kinds. Returns `{ status, ordersSynced, error }`.
- `src/components/SyncProgress.tsx`: client component that re-POSTs `/api/store/sync-step` every
  400 ms while `status === "running"` (44-48), reads `body.ordersSynced`, hard-codes the heading
  "Order sync" (line 52) and the wording "orders" (56, 60), and offers a Retry button (65-73).
- `src/app/settings/store/page.tsx`: renders connection details + one `SyncProgress` for the latest
  job (31-38).
- `src/app/api/store/connect/route.ts`: creates the connection, registers `ORDERS_CREATE` /
  `ORDERS_UPDATED` webhooks (19, 55-62), inserts the order `syncJob` (64-69), returns `{ jobId }`.
- `src/app/api/webhooks/shopify/route.ts`: HMAC verify with the decrypted client secret (35-37),
  then re-fetch the entity over GraphQL rather than trusting the payload (39-55), 500 on failure so
  Shopify retries.

**Money** (`src/lib/money.ts`): `Money { amountCents, currency }`, `money()` throws on non-integers
(13-18), `formatMoney` (50-55), `decimalToCents` for Shopify's decimal strings (61-67). ADR-0004
forbids float money; `docs/adr/0005-fee-hold-rule.md` is the fee-pending rule (relevant to chunk 5,
not this chunk).

**Tooling**: `npm run verify` = typecheck + eslint + prettier check + `vitest run`
(`package.json` 10-23). Vitest picks up `src/**/*.test.ts(x)`, node environment, jsdom opted into
per-file with `// @vitest-environment jsdom` (see `src/app/signup/page.test.tsx:1`). Migrations are
generated with `npm run db:generate` into `drizzle/` with a `meta/_journal.json` entry per migration
(currently 3: `0000`, `0001`, `0002`).

## Approach

**Catalog storage.** Two new tables mirroring the order/line shape: `shopify_product` (keyed by
Shopify product GID, owned by `store_connection`) and `shopify_variant` (keyed by variant GID, owned
by `shopify_product`, no `connection_id` — exactly how `shopify_order_line` hangs off
`shopify_order`). Upserts use `onConflictDoUpdate` on the GID, matching `upsertMappedOrder`, so
re-syncing is idempotent and webhooks and backfill share one write path.

**Resumable catalog sync.** Generalize the existing `sync_job` table rather than adding a parallel
`catalog_sync_job`: add `kind` (`orders` | `products`, default `orders`), make `start_date` nullable
(a catalog job uses it as an optional "updated since" floor; null = full sync), and rename
`orders_synced` → `items_synced`. One job table, one `/api/store/sync-step` route, one
`SyncProgress` component parameterized by label/noun, two page handlers. _Rejected:_ a separate
catalog job table + route + component — it duplicates the cursor/status/retry logic that already
works and doubles the surface chunk 5+ has to understand. _Rejected:_ a background worker or a
single long request that walks all pages — Render's free web tier has no worker and kills long
requests; the browser-driven step loop is the established constraint.

**Cost model.** `variant_cost` is append-only: `(variant_id, unit_cost_cents, currency,
effective_from, note, created_by_user_id, created_at)` with no `updated_at` and no update path.
"Editing" a cost is inserting another row. _Rejected:_ a mutable `variant.cost_cents` column with a
separate audit log — it makes the current value cheap but makes historical resolution depend on
replaying an audit trail, which is exactly the query chunk 5 needs to be trivial and exact.
_Rejected:_ `effective_from`/`effective_to` interval rows — closing the previous row on every insert
means mutating history, which criterion 5 forbids, and back-dated inserts would require rewriting
neighbours.

**Cost resolution.** Split the way `mapping.ts` (pure) and `store.ts` (db) are split: a pure
`resolveCostAt(rows, at)` in `src/lib/cogs/resolve.ts` that is unit-testable with no database, and
db accessors in `src/lib/cogs/store.ts` that fetch rows and delegate. Chunk 5 consumes the db
accessor; the boundary tests in criterion 7 hit the pure function.

### Cost resolution rule (implement exactly this)

Given the cost rows for **one** variant and an instant `at` (for an order, `shopify_order.placed_at`):

1. Keep rows where `effective_from <= at`, comparing absolute instants (`getTime()`), inclusive.
2. Of those, take the row with the greatest `effective_from`.
3. Tie-break equal `effective_from` by greatest `created_at`; if `created_at` also ties, by greatest
   `id` compared as a string. (Deterministic — this is what makes "edit the cost for a date already
   covered" resolve to the newest entry for that date.)
4. If no row qualifies, return `null`. `null` means **no cost is in force**, which is distinct from a
   cost of zero. Callers must branch on it: the UI renders "Not set"; chunk 5 must treat it as a
   blocking "missing COGS" condition. Nothing in this chunk may default a missing cost to `0`.
5. Rows with `effective_from` in the future are legal (schedule a price change); they simply do not
   qualify until `at` reaches them.
6. Effective dates entered through the UI are `<input type="date">` values interpreted as **midnight
   in the shop's timezone** (`store_connection.iana_timezone`, falling back to UTC when it is null),
   stored as `timestamptz`. So for a shop in `America/New_York` a cost effective 2026-07-01 applies
   to an order placed at `2026-07-01T04:00:00Z` and later, and not to one placed at
   `2026-07-01T03:59:59Z`. This supersedes the UTC-midnight rule this plan originally carried here —
   see Decisions, item 1, and open question 1 below. Shipped as `shopDateToInstant` in
   `src/lib/cogs/resolve.ts` (which also disambiguates midnights that DST skips or doubles);
   ADR-0007 records the reasoning.

## Schema and migration changes (explicit)

All in `src/db/schema.ts`, generated into a single new migration `drizzle/0003_*.sql` +
`drizzle/meta/0003_snapshot.json` + a journal entry via `npm run db:generate`.

**New table `shopify_product`**

| column               | type                       | notes                                           |
| -------------------- | -------------------------- | ----------------------------------------------- |
| `id`                 | text PK                    | Shopify product GID                             |
| `connection_id`      | text NOT NULL              | FK → `store_connection.id` ON DELETE CASCADE    |
| `title`              | text NOT NULL              |                                                 |
| `handle`             | text NOT NULL              |                                                 |
| `status`             | text NOT NULL              | Shopify's `ACTIVE`/`ARCHIVED`/`DRAFT`, verbatim |
| `product_type`       | text                       | nullable                                        |
| `vendor`             | text                       | nullable                                        |
| `image_url`          | text                       | nullable, `featuredImage.url`                   |
| `deleted_at`         | timestamptz                | nullable; set by the products/delete webhook    |
| `shopify_updated_at` | timestamptz NOT NULL       |                                                 |
| `synced_at`          | timestamptz NOT NULL now() |                                                 |

**New table `shopify_variant`**

| column               | type                       | notes                                       |
| -------------------- | -------------------------- | ------------------------------------------- |
| `id`                 | text PK                    | Shopify variant GID                         |
| `product_id`         | text NOT NULL              | FK → `shopify_product.id` ON DELETE CASCADE |
| `title`              | text NOT NULL              | e.g. "Black / L"                            |
| `sku`                | text                       | nullable                                    |
| `position`           | integer NOT NULL default 1 |                                             |
| `price_cents`        | integer NOT NULL           | selling price, integer cents (ADR-0004)     |
| `deleted_at`         | timestamptz                | nullable                                    |
| `shopify_updated_at` | timestamptz NOT NULL       |                                             |
| `synced_at`          | timestamptz NOT NULL now() |                                             |

**New table `variant_cost`** (append-only; deliberately has no `updated_at`)

| column               | type                       | notes                                              |
| -------------------- | -------------------------- | -------------------------------------------------- |
| `id`                 | text PK                    | `randomUUID()`                                     |
| `variant_id`         | text NOT NULL              | FK → `shopify_variant.id` ON DELETE CASCADE        |
| `unit_cost_cents`    | integer NOT NULL           | integer cents, `>= 0` enforced in zod at the edge  |
| `currency`           | text NOT NULL              | copied from `store_connection.currency` at insert  |
| `effective_from`     | timestamptz NOT NULL       | Midnight of the chosen date in the shop's timezone |
| `note`               | text                       | nullable, free-text reason for the change          |
| `created_by_user_id` | text                       | FK → `user.id` ON DELETE SET NULL                  |
| `created_at`         | timestamptz NOT NULL now() | tie-breaker in the resolution rule                 |

**Indexes** (the repo declares none today; these three are added deliberately because resolution is
a hot path for chunk 5 and catalog browse joins on them):

- `variant_cost (variant_id, effective_from)`
- `shopify_variant (product_id)`
- `shopify_product (connection_id)`

**Altered table `sync_job`**

- ADD `kind text NOT NULL DEFAULT 'orders'` with the drizzle enum `["orders", "products"]`.
- ALTER `start_date` DROP NOT NULL (a full catalog sync has no start date).
- RENAME `orders_synced` → `items_synced`.

⚠️ `drizzle-kit generate` will prompt about `orders_synced` vs `items_synced` — choose **rename**,
then open the generated SQL and confirm it contains
`ALTER TABLE "sync_job" RENAME COLUMN "orders_synced" TO "items_synced";` and **not** a DROP +ADD
pair, which would silently reset every existing job's progress. The migration must be plain SQL that
PGlite can execute (no `CONCURRENTLY`), because `sync.integration.test.ts:72-82` replays every
`drizzle/*.sql` file.

## Steps

Each step is independently reviewable. Run `npm run verify` before considering any step done.

### 1. Schema + migration

**Files:** `src/db/schema.ts`, new `drizzle/0003_*.sql`, `drizzle/meta/0003_snapshot.json`,
`drizzle/meta/_journal.json` (generated).

Add `shopifyProduct`, `shopifyVariant`, `variantCost` exactly as tabled above, following the file's
existing style (doc comment per table group, `text` PKs, `withTimezone: true`, `text(..., { enum })`).
Alter `syncJob`: add `kind`, drop the `startDate` not-null, rename `ordersSynced` → `itemsSynced`.
Add the three indexes using whatever table-extras form drizzle-orm 0.45 accepts (`(t) => [index(...)]`);
typecheck is the arbiter.

**Proof:** infrastructure step — no test of its own. It is proven by step 6's integration test, which
replays the migration into PGlite. `npm run typecheck` must pass, which will fail loudly at every
chunk-2 reference to `ordersSynced` — those are fixed in step 4.

### 2. Products GraphQL query + mapping

**Files:** `src/lib/shopify/queries.ts`, `src/lib/shopify/mapping.ts`,
`src/lib/shopify/mapping.test.ts`.

Add `PRODUCTS_PAGE_QUERY` alongside `ORDERS_PAGE_QUERY` (same `$first/$after/$query` shape,
`sortKey: UPDATED_AT`), selecting per product: `id title handle status productType vendor updatedAt
featuredImage { url }` and nested `variants(first: 100) { pageInfo { hasNextPage } nodes { id title
sku position price updatedAt } }`.

In `mapping.ts` add `ShopifyProductNode`/`ShopifyVariantNode` interfaces and
`mapProductNode(node): MappedProduct` returning `{ product, variants }`, converting `price` with
`decimalToCents` and dates with `new Date(...)`. Product mapping goes in the existing `mapping.ts`
(this is the Shopify→BizSplit mapping module) rather than a new file.

**Proof:** new `describe("mapProductNode")` cases in `mapping.test.ts` — prices become integer cents,
null `sku`/`productType`/`featuredImage` map to `null`, a product with zero variants maps to an
empty array.

### 3. Catalog sync step

**Files:** new `src/lib/shopify/catalog.ts`.

- `PRODUCT_PAGE_SIZE = 25` (smaller than the order page because each node carries up to 100 nested
  variants).
- `upsertMappedProduct(connectionId, mapped)` — same `onConflictDoUpdate` shape as
  `upsertMappedOrder` (`store.ts:84-115`); updating a product also clears `deleted_at` back to null
  (a product that reappears is not deleted) and upserts each variant.
- `runProductSyncStep(jobId)` — mirrors `runSyncStep` (`store.ts:118-171`): load job, bail unless
  `status === "running"`, load connection, `getAccessToken(conn)` (never read the cached token
  directly, per ADR-0006), fetch one page with `query: job.startDate ? \`updated_at:>='...'\` :
  undefined`, upsert each node, advance `cursor`/`itemsSynced`/`status`, and on throw write
`status: "failed"`+`error`. Count **products** in `itemsSynced`.
- `startCatalogSync(connectionId, since?: Date)` — returns the existing running products job for the
  connection if there is one, else inserts a new `sync_job` row with `kind: "products"`.
- If any product's `variants.pageInfo.hasNextPage` is true, `console.warn` with the product GID (see
  deferred item 6).

Imports `getAccessToken` from `store.ts`; `store.ts` must not import `catalog.ts` (the API route is
the dispatcher) so there is no import cycle.

**Proof:** covered by step 6's integration test.

### 4. Generalize the step route, the component, and the store page

**Files:** `src/lib/shopify/store.ts`, `src/app/api/store/sync-step/route.ts`,
`src/components/SyncProgress.tsx`, `src/app/settings/store/page.tsx`,
`src/lib/shopify/sync.integration.test.ts`.

- `store.ts`: rename `runSyncStep` → `runOrderSyncStep` (symmetry with `runProductSyncStep`; update
  the counter field to `itemsSynced`); `latestSyncJob(connectionId, kind: "orders" | "products" =
"orders")` filters on `kind`; add `getSyncJobForUser(userId, jobId)` that joins `sync_job` →
  `store_connection` on `store_connection.user_id = userId`.
- `sync-step/route.ts`: replace the "must equal the latest job" ownership check (lines 17-21) with
  `getSyncJobForUser`, then dispatch on `job.kind` to `runProductSyncStep` or `runOrderSyncStep`.
  Response becomes `{ status, kind, itemsSynced, error }`.
- `SyncProgress.tsx`: add `label` (heading) and `noun` (e.g. "orders" / "products") props, read
  `body.itemsSynced`.
- `settings/store/page.tsx`: fetch both `latestSyncJob(conn.id, "orders")` and
  `latestSyncJob(conn.id, "products")` and render a `SyncProgress` for each.
- `sync.integration.test.ts`: update to `runOrderSyncStep` / `itemsSynced`. No behavioural change to
  the order path.

**Proof:** the existing order sync integration test still passes unmodified in substance (only the
renamed symbol/field), proving the generalization did not regress chunk 2.

### 5. Kick off and re-run catalog sync

**Files:** `src/app/api/store/connect/route.ts`, new
`src/app/api/store/catalog-sync/route.ts`.

- `connect/route.ts`: after inserting the orders job, call `startCatalogSync(conn.id)` and return
  `catalogJobId` alongside `jobId`. Also add `PRODUCTS_CREATE`, `PRODUCTS_UPDATE`, `PRODUCTS_DELETE`
  to `WEBHOOK_TOPICS` (line 19) — failures already land in `warnings` rather than blocking connect.
- `catalog-sync/route.ts`: POST, session-guarded, resolves the caller's connection, and calls
  `startCatalogSync(conn.id, since)` where `since` = the `created_at` of the most recent **completed**
  products job (incremental re-sync) or undefined when there is none. Returns `{ jobId }`. 409 when a
  products job is already running (return that job's id so the UI can attach to it).

**Proof:** integration coverage in step 6 for `startCatalogSync` reuse/incremental behaviour; the
route itself is thin and follows `connect/route.ts`'s established shape.

### 6. Catalog sync integration test (criterion 8)

**Files:** new `src/lib/shopify/catalog.integration.test.ts`.

Copy the harness from `sync.integration.test.ts:15-90` (PGlite, `vi.mock("@/db")`, migration replay,
queued `fetch` responses, a seeded `user` row). Cases:

1. Two pages of products sync: page one `hasNextPage: true` leaves the job `running` with
   `itemsSynced` = page-one count; page two completes it. Products and variants land in the db with
   `price_cents` as integers.
2. Re-running the same product node (webhook-style) updates title/price without duplicating rows.
3. A 500 from Shopify marks the job `failed` with the status in `error`, and a follow-up job can be
   created and run (resumability after failure).
4. An incremental job with `startDate` set sends a `updated_at:>=` query argument (assert on the
   captured request body).

### 7. Product webhooks

**Files:** `src/app/api/webhooks/shopify/route.ts`, `src/lib/shopify/queries.ts` (if a
single-product fetch query is added), `src/lib/shopify/catalog.ts`.

Branch on `x-shopify-topic`: order topics keep today's path; `products/create` and `products/update`
re-fetch the product over GraphQL by id and `upsertMappedProduct` (same "never trust the payload"
rule as orders, `route.ts:12-17`); `products/delete` sets `deleted_at = now()` on the product and its
variants — **never** deletes rows, because `variant_cost` history hangs off variants.

**Proof:** extend `catalog.integration.test.ts` with a `markProductDeleted` case asserting the
product/variant rows survive with `deleted_at` set and their `variant_cost` rows are untouched.

### 8. Cost resolution (criterion 7)

**Files:** new `src/lib/cogs/resolve.ts`, new `src/lib/cogs/resolve.test.ts`.

Pure module, no db import. Export `interface EffectiveCost { id, unitCostCents, currency,
effectiveFrom, createdAt }` and `resolveCostAt(costs: EffectiveCost[], at: Date): EffectiveCost |
null` implementing the rule above verbatim (filter `<= at`, max `effectiveFrom`, tie-break
`createdAt` then `id`, else `null`). Do not sort in place — copy first, since callers pass query
results they may reuse.

**Proof:** `resolve.test.ts` covering:

- no rows at all → `null`;
- `at` strictly before the earliest `effective_from` → `null` (explicitly asserted as `null`, not `0`);
- `at` exactly equal to an `effective_from` → that row (inclusive boundary);
- `at` between two effective dates → the earlier row;
- `at` after the latest → the latest row;
- a future-dated row is ignored for an `at` before it but wins for an `at` after it;
- two rows sharing an `effective_from` → the one with the later `created_at`;
- input array is not mutated.

### 9. Cost db accessors

**Files:** new `src/lib/cogs/store.ts`.

- `listCatalog({ connectionId, q, limit, offset })` → products (excluding `deleted_at`-set ones by
  default) with their variants, ordered by title then variant position; `q` matches product title or
  handle with `ilike`, or a variant `sku`.
- `costHistoryForVariant(variantId)` → all rows ordered `effective_from desc, created_at desc`.
- `costsForVariants(variantIds)` → all rows for a set of variants, grouped into
  `Map<variantId, EffectiveCost[]>` (one query, grouped in JS — a `DISTINCT ON` optimization is
  deferred, deferred item 8).
- `resolveVariantCostAt(variantId, at)` and `resolveVariantCostsAt(variantIds, at)` → apply
  `resolveCostAt` to the above. **These two are the interface chunk 5 consumes.**
- `insertVariantCost({ variantId, unitCostCents, currency, effectiveFrom, note, createdByUserId })` →
  plain insert, no update/delete path anywhere in the module.
- `variantOwnedByUser(userId, variantId)` → join variant → product → connection → user, used for
  authorization by the API route and the detail page.

**Proof:** new `src/lib/cogs/cogs.integration.test.ts` (PGlite harness as in step 6): seed a
connection, product and variant; insert a cost effective 2026-03-01 and a second effective
2026-06-01; assert `resolveVariantCostAt` returns the first for an order dated 2026-04-15, the second
for 2026-07-01, and `null` for 2026-01-01; assert both rows still exist after the "edit" (criterion 5
at the database level).

### 10. Cost entry API

**Files:** new `src/app/api/costs/route.ts`.

POST, session-guarded like `sync-step/route.ts:10-11`. Zod body:
`{ variantId: string, unitCost: string (decimal, e.g. "12.34"), effectiveFrom: string (YYYY-MM-DD),
note?: string (max 200) }`. Convert with `decimalToCents` from `src/lib/money.ts` — the integer-cents
boundary lives here, and a malformed decimal returns 400. Reject negative costs and anything above a
sane ceiling (10_000_000 cents) with 400. Parse `effectiveFrom` as midnight in the connection's `iana_timezone`, falling back to UTC when it is null. Verify ownership
with `variantOwnedByUser` (404 otherwise), take `currency` from the owning `store_connection`, and
insert. Returns the created row. There is intentionally no PUT/PATCH/DELETE.

**Proof:** cases in `cogs.integration.test.ts` calling the route handler directly (as a plain
function) with a mocked session: `"12.34"` → `1234` cents; `"12.345"` → 400; `"-1.00"` → 400;
a variant belonging to another user → 404.

### 11. Catalog + cost UI (criterion 6)

**Files:** new `src/app/products/page.tsx`, new `src/app/products/[variantId]/page.tsx`, new
`src/components/VariantCostForm.tsx`, new `src/components/VariantCostForm.test.tsx`,
`src/app/dashboard/page.tsx` (nav link).

- `/products` — server component, `requireSession()` + `getConnectionForUser` as in
  `dashboard/page.tsx:11-12`. Empty state with a link to `/settings/store` when no connection, and a
  "catalog not synced yet" state with a "Sync catalog" button (POSTs `/api/store/catalog-sync`, then
  renders `SyncProgress` for the returned job). Table of products → variants with SKU, price, and
  today's cost via `resolveVariantCostsAt(ids, new Date())`, showing "Not set" when `null`. Search box
  and prev/next paging via `?q=` / `?page=` search params.
- `/products/[variantId]` — variant detail: product/variant identity, full cost history table
  (effective date, unit cost, note, entered on), and `VariantCostForm`. 404 unless
  `variantOwnedByUser`. The page copy must say editing adds a new dated record rather than replacing
  the old one.
- `VariantCostForm` — client component styled with `inputCls`/`buttonCls`/`errorCls` from
  `@/components/AuthCard` like `ConnectStoreForm.tsx:5`; fields: unit cost (decimal text), effective
  date (`type="date"`, defaults to today), optional note; POSTs `/api/costs`, then `router.refresh()`.
- Add a "Products & costs" link to the dashboard's link row (`dashboard/page.tsx:93-100`).

**Proof:** `VariantCostForm.test.tsx` (`// @vitest-environment jsdom`, Testing Library, in the style
of `src/app/signup/page.test.tsx`): blocks submit with an inline error on an empty/invalid cost,
blocks submit with no effective date, and on valid input POSTs to `/api/costs` with the decimal
string and the ISO date (assert on a mocked `fetch`).

### 12. Docs and final verification

**Files:** new `docs/adr/0007-effective-dated-costs.md`, `README.md`, `CHANGELOG.md`.

ADR-0007 in the existing 3-section format (Context / Decision / Consequences): costs are
effective-dated, append-only rows; resolution is by the order's `placed_at`; a missing cost resolves
to `null` and is a blocking condition for settlement, never zero. Tick the Chunk 3 box in the README
build plan (line 30) and add the `[Unreleased]`/0.4.0 CHANGELOG entry following the 0.3.0 shape.
Run `npm run verify` and `npm run format` as needed.

## Test plan

Runner: `vitest run` via `npm run test` (part of `npm run verify`). Node environment by default;
jsdom opted in per file.

**Existing files gaining cases**

- `src/lib/shopify/mapping.test.ts` — `mapProductNode` cases (step 2).
- `src/lib/shopify/sync.integration.test.ts` — mechanical updates for `runOrderSyncStep` /
  `itemsSynced` (step 4); it doubles as the regression guard on the `sync_job` generalization.

**New files**

- `src/lib/cogs/resolve.test.ts` — the boundary matrix in step 8 (criterion 7).
- `src/lib/shopify/catalog.integration.test.ts` — paged catalog sync, idempotent upsert, failure +
  retry, incremental query argument, soft delete (criterion 8, steps 6-7).
- `src/lib/cogs/cogs.integration.test.ts` — date-based resolution against real rows, append-only edit
  behaviour, `/api/costs` validation and ownership (steps 9-10).
- `src/components/VariantCostForm.test.tsx` — client validation and submit payload (step 11).

**Edge conditions that must appear somewhere**

Order before any cost (`null`, not `0`); order exactly on an effective date; order between two dates;
two costs with the same effective date; future-dated cost; product with no variants; variant with
null SKU; decimal cost with more than two places rejected; negative cost rejected; cost on a variant
the caller does not own rejected; catalog sync interrupted mid-way and resumed; Shopify 500 during
catalog sync.

## Deliberately deferred

1. **Applying COGS to orders and split math — chunk 5.** Nothing in this chunk writes a resolved cost
   onto `shopify_order_line` or computes margin. The contract chunk 5 consumes is
   `resolveVariantCostAt(variantId, order.placedAt)` / `resolveVariantCostsAt`.
2. **Snapshotting cost onto order lines at settlement time** — chunk 6's concern, once settlements
   need immutable evidence.
3. **The "no cost in force" policy** — this chunk returns `null` and surfaces "Not set" in the UI.
   Whether that blocks a settlement (analogous to the ADR-0005 fee hold) is chunk 5/6's decision.
4. **Bulk cost entry (CSV import, bulk edit, copy cost across variants).** Single-variant entry only.
5. **Voiding or deleting a cost row.** A mistake is corrected by adding another row. If this proves
   painful in use, it needs its own design (a `voided_at` column, not a `DELETE`).
6. **Products with more than 100 variants.** The sync takes the first 100 per product and logs a
   warning; per-product variant paging is deferred.
7. **Seeding costs from Shopify's `inventoryItem.unitCost`.** It would need an extra API scope from
   every connected user; BizSplit's in-app cost is the source of truth for this chunk.
8. **Query optimization of cost resolution** (`DISTINCT ON` / lateral join). Grouping in JS is fine at
   chunk-3 volumes; revisit if chunk 5 resolves thousands of lines per settlement.
9. **Reconciling products deleted while the app was disconnected.** Webhooks plus re-sync cover the
   normal path; a full sweep that marks locally-present-but-upstream-absent products is deferred.
10. **Landed cost breakdown** (freight-in, duties, per-unit vs per-order costs). One unit cost per
    variant per effective date.

## Risks and open questions

**Risks**

- _The `orders_synced` → `items_synced` rename._ If `drizzle-kit` emits DROP + ADD instead of RENAME,
  every existing job's progress resets to 0 on the production database. Verify the generated SQL by
  hand (step 1) before committing.
- _Missing `read_products` scope on existing connections._ Chunk 2's connect copy
  (`ConnectStoreForm.tsx:36-41`) asks for products read access, but any store connected without it
  will get a 403 on the first catalog page. The failure must surface through the existing
  `syncJob.error` path with a remediation hint like the credentials hint in
  `connect/route.ts:73-81`, and the Dev Dashboard app may need reinstalling to widen scopes.
- _Two step-loops running at once._ After step 4 the store settings page can drive an order sync and
  a catalog sync simultaneously against one Render free-tier instance. `SyncProgress` already
  serializes its own calls (`stepping` ref, `SyncProgress.tsx:19-20`), but the two loops are
  independent. If this is a problem in practice, run the catalog job only after the orders job
  completes.
- _`shopify_order_line.variant_id` has no FK to `shopify_variant`_ and this chunk does not add one:
  orders can reference variants that were never synced (deleted before the first catalog sync). Chunk
  5 must handle an order line whose variant is absent from the catalog — the resolver returns `null`
  for it, same as a variant with no cost.

**Open questions (not guessed at — flagging for a decision)**

1. ~~**Effective-date timezone.**~~ RESOLVED — see Decisions, item 1: shop-local timezone, and
   ADR-0007. Original question: this plan used UTC midnight throughout. The Shopify shop has an
   `ianaTimezone`, and a merchant entering "effective 2026-07-01" probably means midnight _shop
   time_. For a US shop that is a 4-8 hour window where an order resolves to the wrong cost. Should
   effective dates be interpreted in the shop's timezone (which means storing `ianaTimezone` on
   `store_connection`)? Shipped that way: `iana_timezone` is captured on the connection at connect
   and refreshed on the first page of each catalog sync, and `shopDateToInstant` converts the
   entered date to the first moment of that day in the zone, falling back to UTC when it is null or
   unknown to the runtime.
2. **Product-level default cost.** Criterion 3 says per variant. Should a product-level cost exist
   that variants inherit unless overridden? Planned as: no.
3. **Costs vs. multi-store.** `variant_cost` hangs off the variant, so it is implicitly scoped to one
   connection. If a user ever connects two stores selling the same physical SKU, costs will be
   duplicated per store. Acceptable for now?
4. **Catalog scope.** Should draft/archived Shopify products sync at all, or only `ACTIVE`? Planned
   as: sync everything, store `status`, and filter to non-deleted in the browse UI — orders can
   reference variants of archived products, so filtering at sync time would create gaps.
5. **Does the currency on a cost need to be user-selectable?** Planned as: no, copied from the
   connection, since ADR-0004 makes cross-currency arithmetic throw and there is no FX story yet.
