# Changelog

All notable changes to BizSplit are documented here. Versions are tagged at the completion of each build-plan chunk.

## [Unreleased]

## [0.1.0] — 2026-07-05 — Chunk 0: Foundation

First deploy: live at [bizsplit.app](https://bizsplit.app) on Render (free web tier + paid Postgres 17).

### Added

- Project scaffold: Next.js + TypeScript (strict), Tailwind, Drizzle ORM, Vitest
- Money primitives (integer cents, basis-point splits) with unit tests
- Health check endpoint, CI pipeline, Render blueprint, ADRs 0001-0005
- Custom domain with automatic TLS; migrations run on every deploy
