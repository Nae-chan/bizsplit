/**
 * Cost-of-goods resolution. Pure: no database, no I/O, so the boundary rules
 * are unit-testable on their own. The db accessors in ./store.ts fetch rows and
 * delegate here; Chunk 5's split engine consumes those accessors.
 */

export interface EffectiveCost {
  id: string;
  unitCostCents: number;
  currency: string;
  effectiveFrom: Date;
  createdAt: Date;
}

/**
 * The cost in force for one variant at an instant (for an order, its
 * `placed_at`). Rows effective in the future are legal — they simply do not
 * qualify until `at` reaches them.
 *
 * Returns `null` when no cost is in force. `null` is NOT a cost of zero:
 * callers must branch on it (the UI shows "Not set"; a settlement treats it as
 * missing COGS). Nothing may default it to 0 — that would silently misprice.
 */
export function resolveCostAt<T extends EffectiveCost>(costs: T[], at: Date): T | null {
  const atMs = at.getTime();
  // filter() copies: callers pass query results they may reuse, so the input
  // array is never reordered in place.
  const inForce = costs.filter((c) => c.effectiveFrom.getTime() <= atMs);
  if (inForce.length === 0) return null;
  return inForce.reduce((best, c) => (isNewer(c, best) ? c : best));
}

/**
 * Later `effective_from` wins; ties break on `created_at`, then on `id` as a
 * string. Deterministic, so re-entering a cost for a date already covered
 * resolves to the newest entry for that date.
 */
function isNewer(a: EffectiveCost, b: EffectiveCost): boolean {
  if (a.effectiveFrom.getTime() !== b.effectiveFrom.getTime()) {
    return a.effectiveFrom.getTime() > b.effectiveFrom.getTime();
  }
  if (a.createdAt.getTime() !== b.createdAt.getTime()) {
    return a.createdAt.getTime() > b.createdAt.getTime();
  }
  return a.id > b.id;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/**
 * Convert an `<input type="date">` value to the instant stored in
 * `effective_from`: the first moment of that date in the shop's own timezone,
 * because a merchant entering "effective 2026-07-01" means their morning, not
 * UTC's. Falls back to UTC when the connection has no `iana_timezone`
 * (connections made before Chunk 3, not yet refreshed by a catalog sync).
 *
 * A DST changeover at midnight leaves local midnight either non-existent or
 * doubled. Both are disambiguated the way Temporal's `compatible` does:
 *
 * - Skipped (clocks jump 00:00 → 01:00: Santiago in September, Havana and the
 *   Azores in March): the day starts at the instant of the jump. Measuring the
 *   offset after the jump would land on the previous local day and apply a new
 *   cost a day early.
 * - Doubled (clocks fall back 01:00 → 00:00: Amman, Gaza and Hebron in October
 *   through 2021, Casey and Vostok in the 2010s and early 2020s): the day
 *   starts at the *earlier* of the two local midnights. Taking the later one
 *   would leave the first hour of the shop's day — three hours, for Casey — on
 *   the previous cost.
 */
export function shopDateToInstant(date: string, timeZone: string | null): Date {
  const m = DATE_ONLY.exec(date.trim());
  if (!m) throw new TypeError(`Not a valid YYYY-MM-DD date: "${date}"`);
  const [, y, mo, d] = m;
  const utcMidnight = Date.UTC(Number(y), Number(mo) - 1, Number(d));
  if (!timeZone) return new Date(utcMidnight);

  let before: number;
  try {
    before = zoneOffsetMs(utcMidnight - DAY_MS, timeZone);
  } catch {
    console.warn(`[cogs] unknown shop timezone "${timeZone}" — interpreting dates as UTC`);
    return new Date(utcMidnight);
  }
  // The offsets in force a day either side bracket every offset local midnight
  // could be on: reading the offset only at UTC midnight misses the other one
  // on a changeover day.
  const after = zoneOffsetMs(utcMidnight + DAY_MS, timeZone);
  const offsets = before === after ? [before] : [before, after];
  // An offset is a real reading of local midnight only where the zone is
  // actually on that offset at the instant it implies. Both can qualify
  // (doubled midnight) or neither (skipped midnight).
  const candidates = offsets
    .map((offset) => utcMidnight - offset)
    .filter((ms) => zoneOffsetMs(ms, timeZone) === utcMidnight - ms);
  if (candidates.length > 0) return new Date(Math.min(...candidates));
  // Skipped: the clocks jump away from local midnight at exactly
  // `utcMidnight - before`, which is the first moment of the requested date.
  return new Date(utcMidnight - before);
}

/**
 * Today's date in the shop's timezone as YYYY-MM-DD — the default the cost
 * form offers, so a merchant entering a cost late in their evening does not get
 * tomorrow's date from UTC. Falls back to UTC like shopDateToInstant.
 */
export function todayInShop(timeZone: string | null, now: Date = new Date()): string {
  if (!timeZone) return now.toISOString().slice(0, 10);
  try {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

/** The wall-clock fields `timeZone` shows at `ms`. Throws on an unknown zone. */
function zonedParts(ms: number, timeZone: string): Record<string, number> {
  let fmt = zoneFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    zoneFormatters.set(timeZone, fmt);
  }
  const parts: Record<string, number> = {};
  for (const p of fmt.formatToParts(new Date(ms))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return parts;
}

/** How far ahead of UTC `timeZone` is at `ms` (a second-aligned instant), in milliseconds. */
function zoneOffsetMs(ms: number, timeZone: string): number {
  const parts = zonedParts(ms, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - ms;
}
