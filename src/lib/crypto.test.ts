import { beforeAll, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "./crypto";

beforeAll(() => {
  process.env.TOKEN_ENCRYPTION_KEY = "test-key-material-for-unit-tests";
});

describe("crypto", () => {
  it("round-trips a secret", () => {
    const secret = "shpat_example_token_123";
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it("produces different ciphertexts for the same input (random IV)", () => {
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it("rejects tampered ciphertext", () => {
    const enc = encryptSecret("secret");
    const parts = enc.split(".");
    const corrupted = Buffer.from(parts[1], "base64");
    corrupted[0] ^= 0xff;
    parts[1] = corrupted.toString("base64");
    expect(() => decryptSecret(parts.join("."))).toThrow();
  });
});
