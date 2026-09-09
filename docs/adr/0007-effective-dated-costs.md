# ADR-0007: Costs are append-only, effective-dated, and resolved by order date

**Status:** Accepted · **Date:** 2026-09-09

## Context

Every split needs the cost of goods behind each order line, and costs change:
a supplier raises a price, a new production run lands. An order placed in July
must be settled against the cost that was in force in July, however many times
the merchant has edited that cost since. A mutable `cost_cents` column plus an
audit log makes today's value cheap to read and makes history — the thing the
split engine actually needs — a replay of the audit trail.

Shopify does not hold BizSplit's cost, so the merchant enters it, as a date
("effective 2026-07-01") rather than an instant.

## Decision

`variant_cost` rows are append-only. The table has no `updated_at`, and the
accessors in `src/lib/cogs/store.ts` expose no update and no delete: editing a
cost inserts another row, and so does correcting a mistake. Resolution takes the
row with the greatest `effective_from` at or before the instant asked about —
for an order, its `placed_at`, never the current date — breaking ties on
`created_at`, then on `id`. Rows dated in the future are legal and simply do not
qualify until that instant arrives.

When no row is in force, resolution returns `null`, and `null` is not a cost of
zero. A variant that was never priced resolves to `null`; so does an order line
pointing at a variant that was never synced, since `shopify_order_line.variant_id`
has no foreign key into the catalog. Callers must branch on it. The UI shows
"Not set", and Chunk 5's split engine must block the settlement rather than
price the line at zero cost: a wrong number that reconciles to the cent is worse
than a settlement that refuses to run, and is the same posture as the fee hold
in ADR-0005.

Effective dates are shop-local. `effective_from` stores the first moment of the
chosen date in the shop's own timezone, read from the Shopify shop's
`ianaTimezone`, cached on `store_connection.iana_timezone` at connect and
refreshed on the first page of each catalog sync; when it is unknown — a
connection made before Chunk 3, or a zone this runtime's `Intl` does not know —
the date is read as UTC midnight. The plan for this chunk specified UTC midnight
throughout, which is wrong for every shop that is not on UTC: for a US shop it
reads orders placed between local midnight and 04:00–08:00 as belonging to the
previous day, so each cost change mispriced a several-hour window of orders.
Resolution still compares absolute instants; only the date-to-instant
conversion (`shopDateToInstant`) is zone-aware.

## Consequences

The current cost is a query over history rather than a column read, which is why
`variant_cost (variant_id, effective_from)` is one of the few indexes this
codebase declares. Nothing is ever lost, so a fat-fingered entry stays visible
in the variant's history table; voiding one would need its own design (a
`voided_at` column, never a `DELETE`). Catalog rows are soft-deleted for the
same reason — cost history hangs off variants, so a product deleted upstream
keeps its rows with `deleted_at` set.

Shop-local dates make the conversion depend on `Intl` and on the zone being
current: a merchant who moves their shop's timezone changes how dates entered
afterwards are read, and costs entered before then keep the instants they were
given. Midnights that DST skips or doubles are resolved to the start of the
shop's day (the jump instant, or the earlier of the two midnights).
