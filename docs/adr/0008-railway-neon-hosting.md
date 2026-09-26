# ADR-0008: Host the app on Railway and the database on Neon

**Status:** Accepted · **Date:** 2026-09-26 · **Supersedes [ADR-0001](0001-render-hosting.md)**

## Context

ADR-0001 put both the web service and Postgres on Render. The reason to leave
was cost. The free web tier that kept the bill down spins down when idle and
runs no pre-deploy step, which is why migrations ran inside the start command.

The app needs one always-on Node process running `next start` (Next.js 16,
including streaming), a managed Postgres 17 with point-in-time restore, and,
from Chunk 6, somewhere to run scheduled work such as the fee reconciliation
that ADR-0005 anticipates. It holds only test data today; real agreements and
settlements, which exist nowhere else, arrive with Chunk 6 or with the first
partner, whichever comes first.

Alternatives considered and rejected:

- **Render** (staying put): cost, as above.
- **Railway Postgres**: backups are a Pro-plan feature, and the database is the
  one component whose loss is unrecoverable.
- **Vercel Hobby**: licensed for non-commercial use only.
- **Netlify**: request limits, and a site that runs out of credits is paused.
- **AWS Amplify**: supports Next.js only up to 15 and without streaming; the app
  is on 16.
- **Supabase**: point-in-time restore is a $100/mo add-on.

## Decision

The app runs on **Railway Hobby** in US East as a single always-on service
running `next start`, built by Railpack and configured as code in
`railway.json`. The database is **Neon** Postgres 17 in AWS us-east-1.

**Connection policy.** `DATABASE_URL` points at Neon's direct endpoint, not the
`-pooler` host, with `sslmode=verify-full`. The app is one long-lived process
with its own `pg` pool, so PgBouncer's transaction mode would only add limits.
`verify-full` is spelled out because `pg` currently treats `require` as an alias
for it with a warning, and `pg` v9 will weaken `require` to libpq's meaning,
which does not verify the server certificate. The pool listens for `error` so
that Neon ending an idle connection, which it does on compute restart or scale
to zero, is logged rather than crashing the process.

**Migrations run as Railway's pre-deploy step** (`npm run db:migrate`). They run
once per deploy rather than on every container restart, and a failed migration
blocks the deploy while the previous deployment keeps serving.
`src/deploy-config.test.ts` pins this, and pins that nothing else migrates: not
the build, install or start scripts, and no per-environment override. The health check at `/api/health` stays database-free: pre-deploy has
already proved the database is reachable, and a database ping on every uptime
check would keep waking Neon's compute.

**Long jobs are resumable and persist their progress.** Each step is idempotent
and its progress lives in the database (`sync_job` for syncs), so a killed or
redeployed process loses nothing. User-started jobs advance one page per HTTP
request, driven from the browser. The web server runs no in-process schedulers
or queues: Railway restarts it at will, and versions overlap during deploys.
Scheduled work runs as a separate Railway cron or worker service under the same
rules, and adding one needs an ADR.

## Gates

These are conditions on future work, not background. Each must be met before
the event it names.

1. **Backups, before real data arrives** (Chunk 6, or partner onboarding if that
   comes first). Neon moves to the Launch plan, whose restore window runs up to
   7 days, **and** an off-platform logical backup is added. Until then the only
   protection is the Neon free plan's 6-hour point-in-time restore.
2. **Migration compatibility, before partners onboard.** Every migration must
   work with the previously deployed version of the app, because Railway keeps
   the old deployment serving traffic while pre-deploy migrates the database
   underneath it. A rename or drop that the old code still reads breaks the live
   site for the length of the deploy.

## Consequences

Neon scales an idle compute to zero, so the first query after a quiet spell pays
a cold start. That is acceptable for a B2B dashboard, and it is why the health
check does not touch the database.

The Neon free plan caps storage and monthly compute. Those limits are Neon's
and change over time; the first gate retires them before they could matter to
real data.

A restore brings back the database and nothing else. `TOKEN_ENCRYPTION_KEY`
(which decrypts stored Shopify credentials) and `BETTER_AUTH_SECRET` live in
Railway's variables, outside the database, so recovering from a restore needs
both of them as they were when the backup was taken. The off-platform backup in
the first gate has to account for them.

`render.yaml` is gone. ADR-0001 stays as the record of the original decision.
