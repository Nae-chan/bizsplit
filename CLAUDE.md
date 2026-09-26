# BizSplit

Partner revenue-sharing manager for e-commerce brands. Every account is equal, partnerships form
through mutually e-signed agreements, and every dollar must be explainable through a per-order math
waterfall.

Ships chunk by chunk. The build plan and its checklist live in `README.md`; architecture decisions
live in `docs/adr/`, and they are binding, not historical notes. Read the relevant ADR before
changing behaviour it covers.

## Commands

```bash
npm run verify      # typecheck + lint + format:check + test — the gate CI enforces
npm run dev
npm run db:generate # after any src/db/schema.ts change
npm run db:migrate
```

`npm run verify` must pass before any work is considered done. Node 22+.

## Non-negotiables

- **Money is integer minor units plus a currency code** (ADR-0004). Never a float, never a bare
  number. Convert at the boundary with `decimalToCents` from `src/lib/money.ts`; cross-currency
  arithmetic throws by design.
- **Unknown is not zero.** A missing cost, fee, or rate resolves to `null` and blocks settlement.
  A silent zero misprices real money. This is the whole premise of the product.
- **v1 calculates; it never moves money** (ADR-0003). No payment rails, no transfers.
- **Settlements hold until actual Shopify fee data arrives** (ADR-0005). Never estimate a fee.
- **Cost history is append-only** (ADR-0007). Editing a cost inserts a new effective-dated row.
  Nothing updates or deletes a `variant_cost` row, and a database trigger in the test suite enforces
  that.
- **Effective dates are shop-local midnight**, from the connection's `iana_timezone`, falling back to
  UTC (ADR-0007). `shopDateToInstant` in `src/lib/cogs/resolve.ts` handles DST, including midnights
  that are skipped or that happen twice. Do not reimplement this conversion elsewhere.
- **Long jobs are resumable and persist their progress.** Each step is idempotent and its progress
  lives in the database (`sync_job` for syncs), so a killed or redeployed process loses nothing.
  User-started jobs advance one page per HTTP request, driven from the browser. The web server runs
  no in-process schedulers or queues: Railway restarts it at will, and versions overlap during
  deploys. Scheduled work runs as a separate Railway cron or worker service under the same rules,
  and adding one needs an ADR.
- **Hosting is Railway (app) + Neon (Postgres 17)** (ADR-0008). Migrations run as Railway's
  pre-deploy step. Before real data (Chunk 6, or partner onboarding if earlier), Neon moves to
  Launch and an off-platform backup is added. Before partners onboard, migrations must work with the
  previously deployed version.
- **Shopify access tokens come from `getAccessToken`** (ADR-0006), never from the encrypted column
  directly. Tokens are short-lived and auto-refreshed. Secrets are AES-256-GCM encrypted at rest via
  `src/lib/crypto.ts`.

## Layout

| path                       | what                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/db/schema.ts`         | every Drizzle table; the single source of schema truth                                                                                           |
| `src/lib/money.ts`         | money primitives, `decimalToCents`, basis-point splits                                                                                           |
| `src/lib/shopify/`         | `client` (GraphQL), `queries`, `mapping` (Shopify to BizSplit), `store` (connections, orders, sync jobs), `catalog` (products), `webhook` (HMAC) |
| `src/lib/cogs/`            | `resolve` (pure, no db) and `store` (queries). `resolveVariantCostAt` is the interface the split engine will consume                             |
| `src/app/api/`             | route handlers, session-guarded via `src/lib/session.ts`                                                                                         |
| `drizzle/`                 | generated migrations plus journal and snapshots                                                                                                  |
| `railway.json`             | Railway build and deploy config; migrations run in `preDeployCommand`, pinned by `src/deploy-config.test.ts`                                     |
| `docs/adr/`, `docs/plans/` | decisions, and per-chunk implementation plans                                                                                                    |

Pure logic goes in a module with no database import, and its queries go in a sibling `store.ts`.
`src/lib/cogs/` is the reference for that split.

## Testing

- **Integration tests run against in-memory Postgres** (PGlite), replaying every `drizzle/*.sql`
  split on `--> statement-breakpoint`, with `vi.mock("@/db")`. Copy the harness from
  `src/lib/shopify/catalog.integration.test.ts`; it resets state in `beforeEach` so cases stand
  alone.
- **Shopify is mocked by queueing fetch responses**, and request bodies are captured so tests can
  assert what was actually sent. Assert on persisted rows, not on call counts.
- **Component tests** use Testing Library and jsdom, per `src/components/SyncProgress.test.tsx`.
  Server components are async functions: call them directly and render the result, per
  `src/app/products/page.test.tsx`.
- Every bug fix gets a regression test. A test that passes when you break the code on purpose is not
  coverage. Timeouts are 30s in `vitest.config.ts` because migration replay is slow.

## Verification rigor, by chunk

qa reads and judges the whole diff on every run. Its two expensive techniques are scoped per chunk,
and the scope belongs in the qa prompt. Mutation probing catches a test that exists and pins
nothing. Differential checking catches a defect the tests and the code agree on because they share
one wrong assumption.

| chunk                        | mutation probe                                              | differential check                          |
| ---------------------------- | ----------------------------------------------------------- | ------------------------------------------- |
| 4 Partnerships & agreements  | the both-signature state machine; who may see or act on one | none                                        |
| 5 Split engine               | all of it                                                   | the waterfall, against golden datasets      |
| 6 Ledger & settlements       | trigger evaluation, fee-hold, netting direction             | netting across both directions              |
| 7 Refunds & statements       | clawback and adjustment arithmetic                          | refund proration                            |
| 8 Notifications & dashboards | visibility scopes only                                      | none                                        |
| 9 Disputes & white label     | the hold flow, which gates money release                    | none                                        |
| 10 Parallel run & cutover    | none beyond the above                                       | the whole month, against the legacy process |

Regardless of chunk, anything that rounds, converts, or persists an amount, any authorization or
tenancy boundary, any migration, and any resume or retry path where a silent no-op looks like
success gets mutation probing. UI wiring, route plumbing, config, and copy do not.

## Database changes

Edit `src/db/schema.ts`, then `npm run db:generate`, then **read the generated SQL before
committing**. `drizzle-kit` prompts on ambiguous changes and will guess wrong. A column rename must
emit `RENAME COLUMN`; a DROP plus ADD silently destroys production data. Migrations already applied
are never hand-edited.

## Process

- Conventional Commits with a scope. One branch per chunk, merged via PR. CI gates every push.
- Completing a chunk means: code merged, the README checklist ticked with its version, a dated
  CHANGELOG section, and a tag. All four, or the chunk is not done.
- If the shipped behaviour diverges from the chunk's one-line description in the README, correct the
  description to match what shipped.
