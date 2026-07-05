# ADR-0003: v1 calculates; it never moves money

**Status:** Accepted · **Date:** 2026-07-04

## Context

Automated payouts (PayPal/Stripe) add compliance surface, failure modes, and trust requirements before the math has earned trust.

## Decision

v1 computes settlements and generates statements/invoices; humans make the actual payment and record it (reference number, date). Automated payout rails are a post-v1 phase.

## Consequences

Zero payment-processing risk in v1. A "mark paid" workflow with audit trail is required. Payout automation later must not change any settlement math.
