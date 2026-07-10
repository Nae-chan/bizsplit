import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * AES-256-GCM encryption for secrets at rest (Shopify access tokens).
 * Key material comes from TOKEN_ENCRYPTION_KEY; we hash it to a uniform
 * 32 bytes so any sufficiently random string works as the env value.
 * Output format: base64(iv).base64(ciphertext).base64(authTag)
 */
function key(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) throw new Error("TOKEN_ENCRYPTION_KEY is not set");
  return createHash("sha256").update(raw).digest();
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv, ciphertext, cipher.getAuthTag()].map((b) => b.toString("base64")).join(".");
}

export function decryptSecret(encrypted: string): string {
  const [iv, ciphertext, tag] = encrypted.split(".").map((p) => Buffer.from(p, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
