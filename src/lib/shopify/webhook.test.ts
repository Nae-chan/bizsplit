import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWebhookHmac } from "./webhook";

const secret = "shpss_test_secret";
const body = JSON.stringify({ id: 123, admin_graphql_api_id: "gid://shopify/Order/123" });
const validHmac = createHmac("sha256", secret).update(body, "utf8").digest("base64");

describe("verifyWebhookHmac", () => {
  it("accepts a valid signature", () => {
    expect(verifyWebhookHmac(body, validHmac, secret)).toBe(true);
  });
  it("rejects a tampered body", () => {
    expect(verifyWebhookHmac(body + " ", validHmac, secret)).toBe(false);
  });
  it("rejects the wrong secret", () => {
    expect(verifyWebhookHmac(body, validHmac, "wrong-secret")).toBe(false);
  });
  it("rejects garbage headers without throwing", () => {
    expect(verifyWebhookHmac(body, "not-base64!!!", secret)).toBe(false);
    expect(verifyWebhookHmac(body, "", secret)).toBe(false);
  });
});
