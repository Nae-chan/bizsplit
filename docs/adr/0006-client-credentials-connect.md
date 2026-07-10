# ADR-0006: Store connections use the client credentials grant

**Status:** Accepted · **Date:** 2026-07-10 · **Supersedes part of the Chunk 2 design**

## Context

Chunk 2 was designed around Shopify's admin-created custom apps and their
permanent `shpat_` access tokens. Shopify removed the ability to create those
apps on 2026-01-01 (discovered during Chunk 2 acceptance, when the admin UI
offered only the new Dev Dashboard). Dev Dashboard apps authenticate with an
OAuth 2 client credentials grant: the app's client ID + secret are exchanged
at `/admin/oauth/access_token` for an access token valid ~24 hours.

## Decision

Connections store the client ID and client secret (both AES-256-GCM encrypted
at rest) plus a cached encrypted access token with its expiry. `getAccessToken`
re-exchanges credentials when the cached token is within 5 minutes of expiry.
Webhook HMAC verification uses the client secret, which is also the webhook
signing key for Dev Dashboard apps.

## Consequences

Every Shopify call path must obtain tokens via `getAccessToken` — never read
the cached token directly. Token exchange failures surface as connection
errors with remediation hints (app not installed, wrong credentials). If
Shopify changes token lifetimes, only the cached-expiry logic cares.
