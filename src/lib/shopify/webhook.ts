import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify a Shopify webhook: HMAC-SHA256 of the raw body with the app's
 * API secret, base64, compared in constant time against the header.
 */
export function verifyWebhookHmac(rawBody: string, hmacHeader: string, secret: string): boolean {
  const digest = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  let header: Buffer;
  try {
    header = Buffer.from(hmacHeader, "base64");
  } catch {
    return false;
  }
  return header.length === digest.length && timingSafeEqual(digest, header);
}
