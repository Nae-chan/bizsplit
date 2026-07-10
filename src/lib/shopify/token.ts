import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { storeConnection } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

/**
 * Client-credentials grant (Shopify Dev Dashboard apps, 2026+).
 * Access tokens live 24h; we cache them on the connection row and
 * refresh when fewer than 5 minutes remain.
 */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export async function exchangeClientCredentials(
  shopDomain: string,
  clientId: string,
  clientSecret: string,
): Promise<{ accessToken: string; expiresAt: Date }> {
  const res = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) {
    const detail =
      res.status === 401 || res.status === 400 ? " — check the Client ID and secret" : "";
    throw new Error(`Shopify token exchange failed (${res.status})${detail}`);
  }
  const body = (await res.json()) as { access_token: string; expires_in: number };
  return {
    accessToken: body.access_token,
    expiresAt: new Date(Date.now() + body.expires_in * 1000),
  };
}

type ConnectionRow = typeof storeConnection.$inferSelect;

/** Returns a valid access token for a connection, refreshing if near expiry. */
export async function getValidToken(conn: ConnectionRow): Promise<string> {
  if (conn.tokenExpiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS) {
    return decryptSecret(conn.encryptedAccessToken);
  }
  const fresh = await exchangeClientCredentials(
    conn.shopDomain,
    conn.clientId,
    decryptSecret(conn.encryptedClientSecret),
  );
  await db
    .update(storeConnection)
    .set({
      encryptedAccessToken: encryptSecret(fresh.accessToken),
      tokenExpiresAt: fresh.expiresAt,
      updatedAt: sql`now()`,
    })
    .where(eq(storeConnection.id, conn.id));
  return fresh.accessToken;
}
