import { describe, expect, it } from "vitest";
import { add, formatMoney, money, percentageShare, subtract } from "./money";

describe("money", () => {
  it("rejects non-integer cents", () => {
    expect(() => money(10.5)).toThrow(TypeError);
  });

  it("adds and subtracts same-currency amounts", () => {
    expect(add(money(150), money(250)).amountCents).toBe(400);
    expect(subtract(money(500), money(199)).amountCents).toBe(301);
  });

  it("refuses cross-currency arithmetic", () => {
    expect(() => add(money(100, "USD"), money(100, "CAD"))).toThrow(/mismatch/);
  });

  it("computes a 50/50 split", () => {
    expect(percentageShare(money(10_000), 5_000).amountCents).toBe(5_000);
  });

  it("rounds half-up on odd splits and reconciles", () => {
    const total = money(101);
    const share = percentageShare(total, 5_000); // 50.5 -> 51
    expect(share.amountCents).toBe(51);
    expect(subtract(total, share).amountCents).toBe(50); // remainder reconciles
  });

  it("handles 0% and 100%", () => {
    expect(percentageShare(money(999), 0).amountCents).toBe(0);
    expect(percentageShare(money(999), 10_000).amountCents).toBe(999);
  });

  it("formats USD", () => {
    expect(formatMoney(money(123_456))).toBe("$1,234.56");
  });
});
