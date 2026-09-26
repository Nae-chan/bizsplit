import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { storeConnection } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { verifyWebhookHmac } from "@/lib/shopify/webhook";
import { shopifyGraphql } from "@/lib/shopify/client";
import { ORDERS_PAGE_QUERY, PRODUCT_BY_ID_QUERY } from "@/lib/shopify/queries";
import {
  mapOrderNode,
  mapProductNode,
  type ShopifyOrderNode,
  type ShopifyProductNode,
} from "@/lib/shopify/mapping";
import { getAccessToken, upsertMappedOrder } from "@/lib/shopify/store";
import { markProductDeleted, upsertMappedProduct } from "@/lib/shopify/catalog";

/**
 * Shopify webhook receiver (orders/create, orders/updated, products/create,
 * products/update, products/delete). We verify the HMAC, then re-fetch the
 * entity via GraphQL rather than trusting the webhook payload — one code path
 * for the data, and the GraphQL shape carries fields the webhook lacks.
 * products/delete is the exception: it soft-deletes, since the product is gone
 * upstream and there is nothing left to fetch.
 */
export async function POST(req: Request) {
  const rawBody = await req.text();
  const hmac = req.headers.get("x-shopify-hmac-sha256");
  const shopDomain = req.headers.get("x-shopify-shop-domain");
  const topic = req.headers.get("x-shopify-topic");
  if (!hmac || !shopDomain) return NextResponse.json({ error: "Missing headers" }, { status: 401 });

  const [conn] = await db
    .select()
    .from(storeConnection)
    .where(eq(storeConnection.shopDomain, shopDomain))
    .limit(1);
  if (!conn || conn.status !== "active") {
    // 200 so Shopify doesn't retry forever for stores we no longer track.
    return NextResponse.json({ ok: true, ignored: true });
  }

  if (!verifyWebhookHmac(rawBody, hmac, decryptSecret(conn.encryptedClientSecret))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  try {
    const payload = JSON.parse(rawBody) as { id?: number | string; admin_graphql_api_id?: string };

    if (topic?.startsWith("products/")) {
      // products/delete sends only a numeric id, no admin_graphql_api_id.
      const productGid =
        payload.admin_graphql_api_id ??
        (payload.id ? `gid://shopify/Product/${payload.id}` : undefined);
      if (!productGid) return NextResponse.json({ ok: true, ignored: true });

      if (topic === "products/delete") {
        await markProductDeleted(productGid);
      } else {
        const token = await getAccessToken(conn);
        const data = await shopifyGraphql<{ product: ShopifyProductNode | null }>(
          conn.shopDomain,
          token,
          PRODUCT_BY_ID_QUERY,
          { id: productGid },
        );
        if (data.product) await upsertMappedProduct(conn.id, mapProductNode(data.product));
      }
      console.info(`[webhook] ${topic} processed for ${shopDomain} (${productGid})`);
      return NextResponse.json({ ok: true });
    }

    const orderGid = payload.admin_graphql_api_id;
    if (!orderGid) return NextResponse.json({ ok: true, ignored: true });

    const token = await getAccessToken(conn);
    const data = await shopifyGraphql<{
      orders: { nodes: ShopifyOrderNode[]; pageInfo: unknown };
    }>(conn.shopDomain, token, ORDERS_PAGE_QUERY, {
      first: 1,
      query: `id:${orderGid.split("/").pop()}`,
    });

    const node = data.orders.nodes[0];
    if (node) await upsertMappedOrder(conn.id, mapOrderNode(node, conn.id));
    console.info(`[webhook] ${topic} processed for ${shopDomain} (${orderGid})`);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error(`[webhook] ${topic} failed for ${shopDomain}:`, e);
    // 500 → Shopify retries with backoff; safe because upserts are idempotent.
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}
