# Changelog

All notable changes to BizSplit are documented here. Versions are tagged at the completion of each build-plan chunk.

## [Unreleased]

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
