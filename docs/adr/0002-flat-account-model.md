# ADR-0002: Flat account model (no owner/collaborator hierarchy)

**Status:** Accepted · **Date:** 2026-07-04

## Context

Incumbent tools (CollabPay) distinguish store-owner accounts from limited collaborator logins. Real partnerships are between equals: either side may run the store, ship goods, or owe money.

## Decision

One account type. Partnerships are first-class entities linking two accounts, created by a mutually e-signed agreement. All permissions and visibility are scoped per agreement, not per account tier. Each account pays its own subscription.

## Consequences

Visibility must be modeled two-directionally per agreement. Agreements need explicit lifecycle states (draft → proposed → active → revision pending → terminated). Disputes need a symmetric resolution flow since no side outranks the other.
