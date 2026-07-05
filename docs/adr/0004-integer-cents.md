# ADR-0004: Money is integer minor units + currency code

**Status:** Accepted · **Date:** 2026-07-04

## Context

Floating-point arithmetic produces rounding drift; a settlement engine must reconcile to the cent.

## Decision

All amounts are stored and computed as integer minor units (cents) alongside an ISO 4217 currency code. Percentages are integer basis points. Rounding is half-up at defined boundaries; remainders reconcile by construction (`total - share`, never `share2 = total * pct2`). Cross-currency arithmetic throws; FX conversions are explicit, with the rate captured per order.

## Consequences

Display formatting divides by 100 at the UI edge only. Currencies with non-2-decimal minor units (JPY, BHD) need a minor-unit map before non-USD/CAD launch.
