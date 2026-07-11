/**
 * Minimal Shopify Admin GraphQL client — plain fetch, no SDK (approved:
 * zero new runtime dependencies for Chunk 2).
 */
export const SHOPIFY_API_VERSION = "2026-04";

export class ShopifyApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ShopifyApiError";
  }
}

export async function shopifyGraphql<T>(
  shopDomain: string,
  accessToken: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch(`https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new ShopifyApiError(`Shopify responded ${res.status} ${res.statusText}`, res.status);
  }
  const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (body.errors?.length) {
    throw new ShopifyApiError(
      `Shopify GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`,
    );
  }
  if (!body.data) throw new ShopifyApiError("Shopify returned no data");
  return body.data;
}

/** Normalizes user-entered domains: strips protocol/trailing slash, validates *.myshopify.com. */
export function normalizeShopDomain(input: string): string {
  const cleaned = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(cleaned)) {
    throw new Error("Shop domain must look like your-store.myshopify.com");
  }
  return cleaned;
}

/**
 * OAuth 2 client credentials grant (Dev Dashboard apps — required since
 * Shopify removed legacy admin-created custom apps on 2026-01-01).
 * Exchanges the app's client ID/secret for a ~24h Admin API access token.
 */
export async function exchangeClientCredentials(
  shopDomain: string,
  clientId: string,
  clientSecret: string,
): Promise<{ accessToken: string; expiresAt: Date }> {
  const res = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) {
    throw new ShopifyApiError(
      `Token exchange failed (${res.status}) — check the client ID/secret and that the app is installed on this store.`,
      res.status,
    );
  }
  const body = (await res.json()) as { access_token: string; expires_in: number };
  return {
    accessToken: body.access_token,
    expiresAt: new Date(Date.now() + body.expires_in * 1000),
  };
}
