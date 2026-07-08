import { describe, expect, it } from "vitest";
import { passwordSchema, signUpSchema } from "./validation";

describe("passwordSchema", () => {
  it("rejects short passwords", () => {
    expect(passwordSchema.safeParse("short1").success).toBe(false);
  });
  it("rejects all-numeric passwords", () => {
    expect(passwordSchema.safeParse("1234567890123").success).toBe(false);
  });
  it("accepts a strong password", () => {
    expect(passwordSchema.safeParse("correct-horse-battery").success).toBe(true);
  });
});

describe("signUpSchema", () => {
  it("requires name and valid email", () => {
    const bad = signUpSchema.safeParse({ name: "", email: "nope", password: "long-enough-pw" });
    expect(bad.success).toBe(false);
  });
  it("accepts optional brand name", () => {
    const ok = signUpSchema.safeParse({
      name: "Nae",
      brandName: "Ripright",
      email: "nae@example.com",
      password: "long-enough-pw",
    });
    expect(ok.success).toBe(true);
  });
});
