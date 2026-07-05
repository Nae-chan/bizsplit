# ADR-0001: Host on Render

**Status:** Accepted · **Date:** 2026-07-04

## Context

The app needs an always-on web service, a managed Postgres database, and (from Chunk 6) background workers and cron for settlement processing and fee reconciliation. Candidates: Vercel, Railway, Fly, Render.

## Decision

Render: explicit background-worker and cron service types, managed Postgres with point-in-time recovery, flat plan-based pricing, blueprint-as-code (`render.yaml`).

## Consequences

Serverless-style edge performance is traded away; acceptable for a B2B dashboard app. Vercel-specific Next.js features (e.g., ISR on edge) are avoided.
