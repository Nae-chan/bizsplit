# Changelog

All notable changes to BizSplit are documented here. Versions are tagged at the completion of each build-plan chunk.

## [Unreleased]

## [0.4.0] — 2026-09-09 — Chunk 3: Products & COGS

### Added

- Product catalog sync (Chunk 3): products and their variants, resumable one page per request on the same `sync_job` machinery as the order backfill (now carrying a `kind`, and counting `items_synced`)
- products/create, products/update and products/delete webhooks; deletes are soft (`deleted_at`), because cost history hangs off variants and past orders still reference them
- Variants that disappear from a product are soft-deleted too — except on a product with more than 100 variants, where only the first page of variants is synced and pruning is skipped, so stale variants can persist there
- Cost of goods per variant: append-only, effective-dated rows in integer cents plus the connection's currency (ADR-0004, ADR-0007). Editing a cost inserts a new row; nothing is updated or deleted
- Effective dates are midnight in the shop's IANA timezone, captured at connect and refreshed on each catalog sync, falling back to UTC when unknown
- Cost resolution by the order's `placed_at`, not today's date. A variant with no cost in force resolves to null — explicitly not zero — as does an order line referencing a variant that was never synced; Chunk 5 must treat both as blocking
- `/products` catalog browser with search, paging and today's cost per variant, plus a per-variant page with full cost history and an add-cost form
- 100 new tests incl. catalog sync, cost resolution and sync-route integration on in-memory Postgres, and a migration test that replays 0003 over live data to prove the `orders_synced` rename keeps in-flight progress (189 total across 19 files)

## [0.3.0] — 2026-07-11 — Chunk 2: Shopify sync

### Added

- Shopify sync (Chunk 2): connect a store with Dev Dashboard client credentials — Shopify removed legacy custom apps on 2026-01-01, so connections exchange an encrypted client ID/secret for short-lived access tokens, auto-refreshed near expiry (ADR-0006)
- Access tokens and webhook secrets encrypted at rest (AES-256-GCM)
- Resumable historical backfill, one page per request — no worker needed on the free tier
- Real-time order ingestion via orders/create + orders/updated webhooks (HMAC-verified, re-fetched over GraphQL)
- Actual gateway fees captured per order; "pending" until Shopify reports them (ADR-0005)
- Order line items stored for future per-product splits; dashboard shows recent orders with fee status
- 19 new tests incl. sync integration on in-memory Postgres with mocked Shopify API (42 total)

## [0.2.0] — 2026-07-08 — Chunk 1: Accounts & auth

### Added

- Accounts & auth (Chunk 1): email/password signup with required email verification, login, logout, password reset — built on better-auth
- One account type for everyone (ADR-0002); optional brand name on profile
- Protected dashboard and account settings; profile editing
- Transactional email via Resend with console fallback in dev
- Zod validation schemas with unit tests
- Auth-flow integration tests against in-memory Postgres (PGlite): signup, blocked unverified login, email verification, password reset, additional fields
- Component tests (Testing Library): password reveal toggle, signup validation (23 tests total)

## [0.1.0] — 2026-07-05 — Chunk 0: Foundation

First deploy: live at [bizsplit.app](https://bizsplit.app) on Render (free web tier + paid Postgres 17).

### Added

- Project scaffold: Next.js + TypeScript (strict), Tailwind, Drizzle ORM, Vitest
- Money primitives (integer cents, basis-point splits) with unit tests
- Health check endpoint, CI pipeline, Render blueprint, ADRs 0001-0005
- Custom domain with automatic TLS; migrations run on every deploy
