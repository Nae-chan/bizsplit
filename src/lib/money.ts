/**
 * All monetary values in BizSplit are integer cents paired with a currency code.
 * Floating-point math is never used for money (see ADR-0004).
 */

export interface Money {
  /** Integer amount in the currency's minor unit (e.g., cents). */
  amountCents: number;
  /** ISO 4217 currency code, e.g. "USD". */
  currency: string;
}

export function money(amountCents: number, currency = "USD"): Money {
  if (!Number.isInteger(amountCents)) {
    throw new TypeError(`Money must be integer cents, got ${amountCents}`);
  }
  return { amountCents, currency };
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountCents + b.amountCents, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountCents - b.amountCents, a.currency);
}

/**
 * Split an amount by a percentage expressed in basis points (1% = 100 bps).
 * Rounds half-up to the nearest cent, which is the convention partners expect
 * on statements. The remainder (amount - share) always reconciles exactly.
 */
export function percentageShare(total: Money, basisPoints: number): Money {
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000) {
    throw new RangeError(`basisPoints must be an integer 0-10000, got ${basisPoints}`);
  }
  const raw = (total.amountCents * basisPoints) / 10_000;
  return money(Math.round(raw), total.currency);
}

/** Format for display, e.g. formatMoney(money(123456)) === "$1,234.56". */
export function formatMoney(m: Money, locale = "en-US"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: m.currency,
  }).format(m.amountCents / 100);
}

/**
 * Convert a decimal money string (Shopify's format, e.g. "12.34") to integer
 * cents without floating-point math. Supports negatives and 0-2 decimals.
 */
export function decimalToCents(decimal: string): number {
  const m = decimal.trim().match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) throw new TypeError(`Not a valid decimal money string: "${decimal}"`);
  const [, sign, whole, frac = ""] = m;
  const cents = parseInt(whole, 10) * 100 + parseInt(frac.padEnd(2, "0") || "0", 10);
  return sign === "-" ? -cents : cents;
}
