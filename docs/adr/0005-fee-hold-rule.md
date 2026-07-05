# ADR-0005: Settlements hold until actual fee data arrives

**Status:** Accepted · **Date:** 2026-07-04

## Context

Splits deduct actual gateway fees (never formula estimates). Shopify Payments reports exact fees asynchronously — sometimes days after the order. A settlement trigger can fire while recent orders lack fee data.

## Decision

A settlement is not finalized until every included order has actual fee data. Orders with pending fees are flagged; the settlement shows as "waiting on fees." Stores using non-Shopify-Payments gateways are flagged at agreement setup and require an explicit fee-handling rule.

## Consequences

Settlements may finalize hours-to-days after their trigger fires — acceptable because v1 payment is manual anyway (ADR-0003). Requires a reconciliation job (worker, Chunk 6) that polls for late fee data.
