# BizSplit

Partner revenue-sharing manager for e-commerce brands. Replaces CollabPay with a flat, peer-to-peer model: every account is equal, partnerships form through mutually e-signed agreements, and **every dollar is explainable** through a per-order math waterfall.

**Status:** in development — building in public, chunk by chunk (see plan below).

## Why it exists

Commission tools assume a store owner and subordinate "collaborators." Real partnerships aren't shaped like that. In BizSplit:

- **Everyone gets the same account.** Accounts stand on their own; partnerships link them.
- **Agreements are pseudo-contracts.** Either partner proposes terms (split %, who covers costs, settlement trigger); both e-sign; revisions require both signatures again.
- **Money flows both ways.** A partnership is a two-way ledger. If Partner 2 ships and shipping cost less than what Partner 1 collected, Partner 2 owes that difference back. Settlements net to one number, either direction.
- **Splits use real numbers.** Actual gateway fees pulled from Shopify — never estimates. Settlements hold until fee data lands.
- **Settlement triggers are flexible.** Every N items sold, sales reaching $X, accrued split reaching $X, or classic time-based.

## Stack

Next.js (App Router) · TypeScript (strict) · PostgreSQL + Drizzle ORM · Vitest · Render (web service + Postgres) · GitHub Actions CI

All money is stored as **integer cents + currency code**. See `docs/adr/` for architecture decisions.

## Build plan

Each chunk ships deployed, tested software and is checked off here on completion.

- [ ] **Chunk 0 — Foundation:** scaffold, CI, Render deploy pipeline, health check, money primitives
- [ ] **Chunk 1 — Accounts & auth:** single account type, signup/login, profiles
- [ ] **Chunk 2 — Shopify sync:** OAuth connect, order webhooks, historical sync, actual fee ingestion
- [ ] **Chunk 3 — Products & COGS:** catalog sync, in-app costs with effective dates
- [ ] **Chunk 4 — Partnerships & agreements:** proposal → both-party e-sign → active; versioned revisions
- [ ] **Chunk 5 — Split engine:** per-order math waterfall; golden-dataset verified to the cent
- [ ] **Chunk 6 — Ledger & settlements:** two-way ledger, four trigger types, fee-hold, netting
- [ ] **Chunk 7 — Refunds & statements:** clawbacks, adjustments, invoices both directions, Excel export
- [ ] **Chunk 8 — Notifications & dashboards:** event notifications, partner-facing dashboards, visibility scopes
- [ ] **Chunk 9 — Disputes & white label:** dispute/hold flow, branding, polish
- [ ] **Chunk 10 — Parallel run & cutover:** full month verified against the legacy process

## Development

```bash
npm install
cp .env.example .env.local   # set DATABASE_URL
npm run db:migrate
npm run dev
```

`npm run verify` runs typecheck, lint, format check, and tests — the same gate CI enforces.

## Process

- Conventional Commits; branch per chunk, merged via PR
- CI (GitHub Actions) gates every push: typecheck, lint, format, tests, build
- A version is tagged and the CHANGELOG updated when each chunk completes
- Architecture decisions live in [`docs/adr/`](docs/adr/)
