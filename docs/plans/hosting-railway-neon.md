# Hosting move: Render to Railway (app) + Neon (Postgres), in code and docs

> Plan only. Branch: `hosting-railway-neon`, cut from `main` (PR #6 is merged, v0.4.0 is tagged).
> This is infrastructure work, not a build-plan chunk. It ships under CHANGELOG `[Unreleased]`.

## Goal

The move is already live. `bizsplit` on Railway serves https://bizsplit.app from Neon (Postgres 17,
direct endpoint, `sslmode=verify-full`). This plan brings the repo in line with that:

- Railway config-as-code replaces `render.yaml`, and migrations become a pre-deploy step.
- A new ADR supersedes ADR-0001 and records the backup and migration-compatibility deferrals as
  gates.
- The "no background workers" rule is reworded now that its Render reason is gone.
- The DB pool survives Neon ending idle connections.
- The docs stop naming Render as the host.

There is no cutover, data copy, or backup job in scope.

## Acceptance criteria

The probe scope follows CLAUDE.md:89-91. Migrations are probed. Config, copy, and plumbing are not.

1. **AC-1** `railway.json` at the repo root is exactly the verified config below (same keys, same
   values), and `render.yaml` no longer exists.
   - Probe: none (config).
2. **AC-2** Migrations run once per deploy, in the pre-deploy phase. The deploy start command does
   not run migrations, and neither does `package.json` `scripts.start`. `src/deploy-config.test.ts`
   fails if `preDeployCommand` stops running `npm run db:migrate`, if the start command or
   `scripts.start` starts running migrations, if `healthcheckPath` no longer names an existing route,
   or if `render.yaml` comes back.
   - Probe: yes (migration path). Each of these mutations must fail the test:
     - remove `db:migrate` from `preDeployCommand`;
     - prepend `npm run db:migrate && ` to `startCommand`;
     - add `db:migrate` to `scripts.start`;
     - change `healthcheckPath` to `/api/nope`.
3. **AC-3** On the first Railway deploy after merge, the deploy log shows the pre-deploy command
   running `drizzle-kit migrate`, exiting 0, and applying nothing (Neon is already migrated) before
   the new deployment goes live. Afterwards `GET https://bizsplit.app/api/health` returns 200.
   - Probe: none beyond AC-2. This is a one-time live observation. If it fails because `drizzle-kit`
     or `dotenv` is missing, apply the Step 5 fallback and repeat.
4. **AC-4** When the database ends an idle pooled connection, the error is logged and the process
   keeps running. `src/db/index.test.ts` emits `error` on the exported pool and asserts it neither
   throws nor goes unlogged. The pool is configured with `max: 10`, `idleTimeoutMillis: 10_000`, and
   `connectionTimeoutMillis: 10_000`.
   - Probe: none (not money, auth, migration, or resume). The test fails by construction without the
     listener, because `EventEmitter` throws on an unhandled `error`.
5. **AC-5** `docs/adr/0008-railway-neon-hosting.md` exists with status Accepted and records all of
   the following:
   - (a) Railway Hobby (US East, always-on `next start`) for the app and Neon (Postgres 17, AWS
     us-east-1) for the database;
   - (b) rejected alternatives, each with its reason: Render (cost), Railway Postgres (backups are
     Pro-only), Vercel Hobby (non-commercial only), Netlify (request limits and credit pauses), AWS
     Amplify (Next.js only up to 15 and no streaming, while the app is on 16), and Supabase
     (point-in-time restore is a $100/mo add-on);
   - (c) connection policy: direct endpoint, `sslmode=verify-full`;
   - (d) migrations run as Railway's pre-deploy step;
   - (e) the reworded long-jobs rule, and that any worker or cron service needs its own ADR;
   - (f) a **Gate** stating that before real data arrives (Chunk 6, or partner onboarding if that
     comes first), Neon moves to the Launch plan (restore window up to 7 days) **and** an
     off-platform logical backup is added. Until then the protection is Neon free's 6-hour
     point-in-time restore;
   - (g) a **Gate** stating that before partners onboard, migrations must work with the previously
     deployed version, because Railway keeps the old deployment serving while pre-deploy migrates.

   `docs/adr/0001-render-hosting.md` keeps its body and its status reads "Superseded by ADR-0008".
   - Probe: none (copy).

6. **AC-6** CLAUDE.md no longer says the app runs on Render. The long-jobs bullet carries the
   reworded rule. A hosting bullet cites ADR-0008 and both gates. The Layout table lists
   `railway.json`.
   - Probe: none (copy).
7. **AC-7** README says Railway + Neon in the stack line, and its Chunk 0 line records the move.
   `.env.example` documents the production URL shape (Neon direct host, `sslmode=verify-full`).
   CHANGELOG `[Unreleased]` has Changed and Removed entries, and released sections are untouched.
   Outside ADR-0001, released CHANGELOG sections, `src/db/schema.ts:4` (a historical comment), and
   older `docs/plans/*`, no file presents Render as the current host.
   - Probe: none (copy).
8. **AC-8** `npm run verify` passes and CI is green on the PR.

## Current state

**Live, as reported by the coordinator (not verified from the repo):**

- The Railway service `bizsplit` is Active on bizsplit.app. The custom domain is verified.
- The Railway Postgres service was deleted.
- Variables include `BETTER_AUTH_URL=https://bizsplit.app` and a `DATABASE_URL` for the Neon direct
  endpoint with `sslmode=verify-full`.
- Migrations were applied to Neon by hand. The current deploy has no `railway.json` and built with
  Railpack defaults.
- Render is frozen. Its data was test data and was not copied. Secrets were regenerated.

**Repo (read on `main`):**

- `render.yaml:17-19` sets build `npm ci && npm run build` and start
  `npm run db:migrate && npm run start` (reason in lines 10-11: the free tier had no pre-deploy),
  with health path `/api/health`.
- `docs/adr/0001-render-hosting.md:3` holds the status line. Line 7 anticipates workers and cron from
  Chunk 6.
- `package.json:13` sets `start` to `next start`. `package.json:21` sets `db:migrate` to
  `drizzle-kit migrate`. `drizzle-kit` (line 46) and `dotenv` (line 45) are **devDependencies**,
  and `drizzle.config.ts:1-2` imports both. `drizzle.config.ts:5,11` mention Render in a comment and
  in the error text.
- `src/db/index.ts:5` is `new Pool({ connectionString: process.env.DATABASE_URL })`. It sets no
  options and no `error` listener, and it does not export `pool`.
- The installed `pg` is 8.22.0. In `node_modules/pg-connection-string/index.js:139-157,219-230`,
  `require` already aliases to `verify-full` with a warning, and pg v9 will weaken `require` to libpq
  semantics. So `verify-full` is the right explicit value.
- `src/app/api/health/route.ts:1-9` is DB-free. Its comment (lines 3-6) names Render.
- `CLAUDE.md:37-38` is the rule to reword. `CLAUDE.md:43-53` is Layout. `CLAUDE.md:89-91` is the
  general probe rule.
- `README.md:19` is the stack line. `README.md:27` is Chunk 0.
- `CHANGELOG.md:5` is the empty `[Unreleased]`.
- `.env.example:2` is the local `DATABASE_URL`.
- Where the gates go: CLAUDE.md:7-9 says ADRs are binding. README checklist lines must describe what
  shipped (CLAUDE.md:105-106). So the gates belong in ADR-0008, not the README checklist. CLAUDE.md
  points at them so agents see them.

## Approach

- **Pre-deploy migration.** Migrations move from the start command to `preDeployCommand`, so they
  run once per deploy and a failure blocks the deploy.
  - _Rejected: keeping `db:migrate && start`._ It re-runs migrations on every container restart.
- **Health check stays DB-free.** Pre-deploy already proves the DB works, and a DB ping would wake
  Neon's scale-to-zero compute on every uptime check.
- **Pool hardening.** An `error` listener stops a Neon compute restart from crashing the process
  through an idle client.
  - _Rejected: switching to Neon's pooler._ This is one long-lived process with its own pool, so
    PgBouncer transaction mode only adds limits.
- **Long-jobs rule: softened, not retired.**
  - The Render reason is gone, but saved progress and idempotent steps still matter: Railway restarts
    the process at will and overlaps versions during deploys.
  - Retiring the rule invites in-process timers that double-run or die.
  - Keeping it verbatim blocks the Chunk 6 cron that ADR-0001:7 expected.
  - No sync code changes.

## Steps

Run `npm run verify` before calling any step done. Commits use Conventional Commits with a scope.

### 1. ADR-0008 and ADR-0001 status (`docs(adr)`)

**Files:** new `docs/adr/0008-railway-neon-hosting.md` (layout of `docs/adr/0007-effective-dated-costs.md`:
Status line with `Supersedes ADR-0001`, Context, Decision, Consequences). Edit
`docs/adr/0001-render-hosting.md:3` to
`**Status:** Superseded by [ADR-0008](0008-railway-neon-hosting.md) · **Date:** 2026-07-04`.

- ADR content is AC-5 (a) to (g). Put both gates under a `## Gates` heading so they can't be mistaken
  for background.
- Consequences to record:
  - Neon cold starts after idle.
  - The free-plan caps.
  - A restore also needs `TOKEN_ENCRYPTION_KEY` and `BETTER_AUTH_SECRET`, which live outside the
    database.
- The long-jobs wording:

  > **Long jobs are resumable and persist their progress.** Each step is idempotent and its progress
  > lives in the database (`sync_job` for syncs), so a killed or redeployed process loses nothing.
  > User-started jobs advance one page per HTTP request, driven from the browser. The web server runs
  > no in-process schedulers or queues: Railway restarts it at will, and versions overlap during
  > deploys. Scheduled work runs as a separate Railway cron or worker service under the same rules,
  > and adding one needs an ADR.

**Proof:** AC-5, by reading.

### 2. `railway.json`, delete `render.yaml`, config test (`chore(deploy)`)

**Files:** new `railway.json`, delete `render.yaml`, new `src/deploy-config.test.ts`, and comment
edits in `src/app/api/health/route.ts:3-6` ("Railway deploy health check; DB-free on purpose") and
`drizzle.config.ts:5,11` ("CI/Railway").

`railway.json`, verified against Railway's config-as-code docs by the coordinator:

```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": { "builder": "RAILPACK" },
  "deploy": {
    "preDeployCommand": ["npm run db:migrate"],
    "startCommand": "npm run start",
    "healthcheckPath": "/api/health",
    "restartPolicyType": "ON_FAILURE"
  }
}
```

Let prettier choose the final layout.

The test is `src/deploy-config.test.ts` (node environment, no DB). It reads `railway.json` and
`package.json` and asserts:

- `deploy.preDeployCommand` is an array whose only entry is `npm run db:migrate`;
- `deploy.startCommand` does not match `/migrate|drizzle-kit/`;
- `scripts.start` does not match `/migrate/`;
- `deploy.healthcheckPath` is `/api/health` and `src/app/api/health/route.ts` exists;
- `render.yaml` does not exist.

**Proof:** AC-1 and AC-2.

### 3. Neon-safe pool (`fix(db)`)

**Files:** `src/db/index.ts`, new `src/db/index.test.ts`.

- Build the Pool with `connectionString`, `max: 10`, `idleTimeoutMillis: 10_000`, and
  `connectionTimeoutMillis: 10_000`.
- Add `pool.on("error", (err) => console.error("[db] idle client error:", err.message))`.
- `export const pool`. Keep `db` as is; the existing `vi.mock("@/db")` factories mock only `db`.
- Test (imports `./index` for real; constructing a Pool does not connect):
  - `pool.listenerCount("error") > 0`;
  - `pool.emit("error", new Error("terminating connection due to administrator command"))` does not
    throw;
  - a `console.error` spy saw `terminating connection`.

**Proof:** AC-4.

### 4. Docs (`docs`)

**Files:**

- `README.md:19`: `... · Railway (web service) + Neon (Postgres) · GitHub Actions CI`.
- `README.md:27`: change "Render deploy pipeline" to
  "deploy pipeline (shipped on Render; moved to Railway + Neon, ADR-0008)".
- `CLAUDE.md`:
  - Replace lines 37-38 with the Step 1 long-jobs wording.
  - Add a Non-negotiables bullet: **Hosting is Railway (app) + Neon (Postgres 17)** (ADR-0008).
    Migrations run as Railway's pre-deploy step. Before real data (Chunk 6, or partner onboarding
    if earlier), Neon moves to Launch and an off-platform backup is added. Before partners onboard,
    migrations must work with the previously deployed version.
  - Add a Layout row for `railway.json` and re-align the table for prettier.
- `.env.example:2`: keep the local default. Add a comment above it with the production shape,
  `postgresql://USER:PASSWORD@ep-XXXX.us-east-1.aws.neon.tech/neondb?sslmode=verify-full` (direct
  host, not `-pooler`).
- `CHANGELOG.md:5`, under `[Unreleased]`:
  - **Changed:** hosting is Railway + Neon (ADR-0008 supersedes ADR-0001). Migrations run as a
    pre-deploy step. The DB pool logs, rather than crashes on, idle-connection errors. The long-jobs
    rule is reworded.
  - **Removed:** `render.yaml`.

**Proof:** AC-6 and AC-7, by reading plus the grep in AC-7. `format:check` must pass. AC-8 covers the
whole branch.

### 5. First deploy after merge (observation, no code)

After the PR merges, read the Railway deploy log for the `main` build and check AC-3. Also note the
Node major that Railpack chose. CI uses 22 (`.github/workflows/ci.yml:15`), and `package.json:7-9`
`>=22` could resolve higher.

Fallback if pre-deploy fails because `drizzle-kit` or `dotenv` is missing (the Railway docs don't
say whether devDependencies are present during pre-deploy), in order:

1. Move `drizzle-kit` and `dotenv` to `dependencies`.
2. Or replace the pre-deploy command with a `tsx` script using `drizzle-orm/node-postgres/migrator`,
   which is backed by the same `drizzle.__drizzle_migrations` table. Verify that when implementing.

A failed pre-deploy leaves the current deployment serving, so this check carries no downtime risk.

## Test plan

Runner: Vitest (`npm run test`, via `npm run verify`).

- New `src/deploy-config.test.ts`: AC-2 invariants, including the four mutations listed there.
- New `src/db/index.test.ts`: AC-4.
- No existing tests change. Everything else is covered by the AC-3 live observation and by reading
  (AC-5 to AC-7).

## Risks and open questions

1. **devDependencies at pre-deploy.** Unverified. AC-3 is the check and Step 5 is the fallback.
2. **Node version on Railpack.** It may not be 22. If it isn't, pin it with Railpack's documented
   mechanism in a follow-up; this plan doesn't guess the mechanism.
3. **Live state is taken from the coordinator's report.** Nothing in this plan re-verifies it.
4. **Where the gates live.** The plan puts them in ADR-0008, with pointers in CLAUDE.md, rather than
   in the README checklist, whose lines must describe shipped behaviour. If the owner wants the gate
   on the README Chunk 6 line as well, it is a one-line addition.
