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
