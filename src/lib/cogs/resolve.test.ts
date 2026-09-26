import { describe, expect, it, vi } from "vitest";
import { resolveCostAt, shopDateToInstant, todayInShop, type EffectiveCost } from "./resolve";

/**
 * The boundary matrix for cost resolution (criterion 7) and the shop-local
 * reading of an effective date. Both are pure — no database in this file.
 */

type CostOverrides = Omit<Partial<EffectiveCost>, "effectiveFrom"> & { effectiveFrom: string };

function cost(over: CostOverrides): EffectiveCost {
  return {
    id: over.id ?? `cost-${over.effectiveFrom}`,
    unitCostCents: over.unitCostCents ?? 1000,
    currency: over.currency ?? "USD",
    effectiveFrom: new Date(over.effectiveFrom),
    createdAt: over.createdAt ?? new Date("2026-01-01T00:00:00.000Z"),
  };
}

const march = cost({ id: "march", effectiveFrom: "2026-03-01T00:00:00.000Z", unitCostCents: 800 });
const june = cost({ id: "june", effectiveFrom: "2026-06-01T00:00:00.000Z", unitCostCents: 950 });

describe("resolveCostAt", () => {
  it("returns null when the variant has no costs at all", () => {
    expect(resolveCostAt([], new Date("2026-04-15T00:00:00.000Z"))).toBeNull();
  });

  it("returns null — not a zero cost — for an order placed before any cost exists", () => {
    const resolved = resolveCostAt([march, june], new Date("2026-01-01T00:00:00.000Z"));
    expect(resolved).toBeNull();
    // A missing cost is "unknown", never 0: Chunk 5 must block on it rather
    // than settle at 100% margin.
    expect(resolved).not.toBe(0);
    expect(resolved?.unitCostCents).toBeUndefined();
  });

  it("includes the effective date itself (inclusive boundary)", () => {
    expect(resolveCostAt([march, june], new Date("2026-03-01T00:00:00.000Z"))?.id).toBe("march");
  });

  it("excludes an order one millisecond before the effective date", () => {
    expect(resolveCostAt([march], new Date("2026-02-28T23:59:59.999Z"))).toBeNull();
  });

  it("resolves an order between two effective dates to the earlier cost", () => {
    const resolved = resolveCostAt([march, june], new Date("2026-04-15T12:00:00.000Z"));
    expect(resolved?.id).toBe("march");
    expect(resolved?.unitCostCents).toBe(800);
  });

  it("resolves an order after the latest effective date to the latest cost", () => {
    expect(resolveCostAt([march, june], new Date("2026-09-09T00:00:00.000Z"))?.id).toBe("june");
  });

  it("ignores a future-dated cost until the order date reaches it", () => {
    const scheduled = cost({ id: "scheduled", effectiveFrom: "2026-12-01T00:00:00.000Z" });
    expect(resolveCostAt([march, scheduled], new Date("2026-11-30T00:00:00.000Z"))?.id).toBe(
      "march",
    );
    expect(resolveCostAt([march, scheduled], new Date("2026-12-02T00:00:00.000Z"))?.id).toBe(
      "scheduled",
    );
  });

  it("breaks a tie on effective date with the later created_at", () => {
    const first = cost({
      id: "a",
      effectiveFrom: "2026-06-01T00:00:00.000Z",
      unitCostCents: 900,
      createdAt: new Date("2026-05-01T10:00:00.000Z"),
    });
    const corrected = cost({
      id: "b",
      effectiveFrom: "2026-06-01T00:00:00.000Z",
      unitCostCents: 975,
      createdAt: new Date("2026-05-02T10:00:00.000Z"),
    });
    const at = new Date("2026-06-10T00:00:00.000Z");
    expect(resolveCostAt([first, corrected], at)?.unitCostCents).toBe(975);
    // Order of the input array must not change the answer.
    expect(resolveCostAt([corrected, first], at)?.unitCostCents).toBe(975);
  });

  it("breaks a full tie on effective date and created_at with the greater id", () => {
    const shared = {
      effectiveFrom: "2026-06-01T00:00:00.000Z",
      createdAt: new Date("2026-05-01T10:00:00.000Z"),
    };
    const a = cost({ id: "aaa", ...shared });
    const b = cost({ id: "bbb", ...shared });
    const at = new Date("2026-06-10T00:00:00.000Z");
    expect(resolveCostAt([a, b], at)?.id).toBe("bbb");
    expect(resolveCostAt([b, a], at)?.id).toBe("bbb");
  });

  it("does not mutate or reorder the array it is given", () => {
    const rows = [june, march];
    resolveCostAt(rows, new Date("2026-09-09T00:00:00.000Z"));
    expect(rows).toEqual([june, march]);
    expect(rows[0]).toBe(june);
  });
});

describe("shopDateToInstant", () => {
  it("reads a date as UTC midnight when the shop has no timezone", () => {
    expect(shopDateToInstant("2026-07-01", null).toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("reads a date as midnight in the shop's own timezone", () => {
    // New York is UTC-4 on 1 July: local midnight is 04:00Z.
    expect(shopDateToInstant("2026-07-01", "America/New_York").toISOString()).toBe(
      "2026-07-01T04:00:00.000Z",
    );
    // Auckland is UTC+12 on 1 July: local midnight is the previous day in UTC.
    expect(shopDateToInstant("2026-07-01", "Pacific/Auckland").toISOString()).toBe(
      "2026-06-30T12:00:00.000Z",
    );
  });

  it("gives a western shop a different instant than a UTC shop for the same date", () => {
    const utcShop = shopDateToInstant("2026-07-01", null);
    const laShop = shopDateToInstant("2026-07-01", "America/Los_Angeles");
    expect(laShop.getTime()).not.toBe(utcShop.getTime());
    expect(laShop.getTime() - utcShop.getTime()).toBe(7 * 60 * 60 * 1000);
  });

  it("tracks the shop's winter offset as well as its summer one", () => {
    expect(shopDateToInstant("2026-01-15", "America/New_York").toISOString()).toBe(
      "2026-01-15T05:00:00.000Z",
    );
    expect(shopDateToInstant("2026-07-15", "America/New_York").toISOString()).toBe(
      "2026-07-15T04:00:00.000Z",
    );
  });

  it("handles a date whose local midnight falls on a DST changeover day", () => {
    // US DST starts 08-03-2026 at 02:00 local; midnight is still UTC-5.
    expect(shopDateToInstant("2026-03-08", "America/New_York").toISOString()).toBe(
      "2026-03-08T05:00:00.000Z",
    );
    // Lord Howe shifts at 02:00 too, but by 30 minutes, on 2026-04-05.
    expect(shopDateToInstant("2026-04-05", "Australia/Lord_Howe").toISOString()).toBe(
      "2026-04-04T13:00:00.000Z",
    );
    // Auckland ends DST at 03:00 on 2026-04-05, so UTC midnight of that date
    // already sits after the change (+12) while local midnight is still +13.
    // Measuring the offset only at UTC midnight would land an hour late.
    expect(shopDateToInstant("2026-04-05", "Pacific/Auckland").toISOString()).toBe(
      "2026-04-04T11:00:00.000Z",
    );
  });

  it("handles a zone whose offset is not a whole hour", () => {
    expect(shopDateToInstant("2026-07-01", "Asia/Kolkata").toISOString()).toBe(
      "2026-06-30T18:30:00.000Z",
    );
  });

  it("falls back to UTC when the shop reports a timezone the runtime cannot read", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(shopDateToInstant("2026-07-01", "Mars/Olympus_Mons").toISOString()).toBe(
      "2026-07-01T00:00:00.000Z",
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("rejects anything that is not a YYYY-MM-DD date", () => {
    expect(() => shopDateToInstant("01/07/2026", "UTC")).toThrow(TypeError);
    expect(() => shopDateToInstant("2026-07-01T00:00:00Z", "UTC")).toThrow(TypeError);
    expect(() => shopDateToInstant("", null)).toThrow(TypeError);
  });
});

describe("todayInShop", () => {
  it("returns the shop's own date, which can differ from the UTC date", () => {
    // 23:30 UTC on 30 June is already 1 July in Auckland and still 30 June in
    // Los Angeles — the default the cost form offers has to follow the shop.
    const now = new Date("2026-06-30T23:30:00.000Z");
    expect(todayInShop("Pacific/Auckland", now)).toBe("2026-07-01");
    expect(todayInShop("America/Los_Angeles", now)).toBe("2026-06-30");
    expect(todayInShop(null, now)).toBe("2026-06-30");
  });

  it("falls back to the UTC date for a timezone the runtime cannot read", () => {
    expect(todayInShop("Mars/Olympus_Mons", new Date("2026-06-30T23:30:00.000Z"))).toBe(
      "2026-06-30",
    );
  });
});

describe("resolution across the shop-local window", () => {
  it("resolves an order placed just after shop-local midnight to the new cost", () => {
    // The merchant sets a new cost effective 2026-07-01 for a New York shop.
    const newCost = cost({
      id: "july",
      effectiveFrom: shopDateToInstant("2026-07-01", "America/New_York").toISOString(),
      unitCostCents: 1100,
    });
    const rows = [march, newCost];

    // 00:30 New York time on 1 July = 04:30Z — the new cost is in force.
    expect(resolveCostAt(rows, new Date("2026-07-01T04:30:00.000Z"))?.unitCostCents).toBe(1100);
    // 23:30 New York time on 30 June = 03:30Z on 1 July. Still the old cost:
    // interpreting the date as UTC midnight would have got this order wrong.
    expect(resolveCostAt(rows, new Date("2026-07-01T03:30:00.000Z"))?.unitCostCents).toBe(800);
  });
});

describe("shopDateToInstant where local midnight does not exist", () => {
  // Zones that jump 00:00 → 01:00: the shop's day starts at 01:00 local, and
  // measuring the offset after the jump used to place effective_from an hour
  // before that — on the previous local day, so a cost took effect a day early.
  it("starts Santiago's day at the jump, not on the previous day", () => {
    expect(shopDateToInstant("2026-09-06", "America/Santiago").toISOString()).toBe(
      "2026-09-06T04:00:00.000Z",
    );
    expect(shopDateToInstant("2027-09-05", "America/Santiago").toISOString()).toBe(
      "2027-09-05T04:00:00.000Z",
    );
  });

  it("starts Havana's day at the jump, not on the previous day", () => {
    expect(shopDateToInstant("2026-03-08", "America/Havana").toISOString()).toBe(
      "2026-03-08T05:00:00.000Z",
    );
    expect(shopDateToInstant("2027-03-14", "America/Havana").toISOString()).toBe(
      "2027-03-14T05:00:00.000Z",
    );
  });

  it("holds the old cost through the evening before a midnight jump", () => {
    const newCost = cost({
      id: "spring",
      effectiveFrom: shopDateToInstant("2026-09-06", "America/Santiago").toISOString(),
      unitCostCents: 1100,
    });
    const rows = [march, newCost];
    // 23:30 on 5 September in Santiago (still UTC-4) — the day the new cost
    // applies to has not started, so the old cost stands.
    expect(resolveCostAt(rows, new Date("2026-09-06T03:30:00.000Z"))?.unitCostCents).toBe(800);
    // 01:30 on 6 September, half an hour after the clocks jumped: the new cost.
    expect(resolveCostAt(rows, new Date("2026-09-06T04:30:00.000Z"))?.unitCostCents).toBe(1100);
  });
});

describe("shopDateToInstant where local midnight happens twice", () => {
  // Zones that fall back 01:00 → 00:00: local midnight comes round twice and
  // the shop's day starts at the first one. Taking the second used to leave the
  // hour between them (three hours for Casey) on the previous cost.
  it("starts Amman's day at the first of its two midnights", () => {
    // 2021-10-29 in Amman: 00:00 at UTC+3, then 01:00 winds back to 00:00 at
    // UTC+2. 21:00Z is the first; a second before 22:00Z is already 00:59 local
    // on the 29th, so 22:00Z would be an hour into the day.
    expect(shopDateToInstant("2021-10-29", "Asia/Amman").toISOString()).toBe(
      "2021-10-28T21:00:00.000Z",
    );
    expect(shopDateToInstant("2021-10-29", "Asia/Gaza").toISOString()).toBe(
      "2021-10-28T21:00:00.000Z",
    );
    expect(shopDateToInstant("2021-10-29", "Asia/Hebron").toISOString()).toBe(
      "2021-10-28T21:00:00.000Z",
    );
  });

  it("starts Casey's day at the first of two midnights three hours apart", () => {
    // Casey winds back 3 hours at midnight: UTC+11 to UTC+8.
    expect(shopDateToInstant("2019-03-17", "Antarctica/Casey").toISOString()).toBe(
      "2019-03-16T13:00:00.000Z",
    );
    expect(shopDateToInstant("2023-03-09", "Antarctica/Casey").toISOString()).toBe(
      "2023-03-08T13:00:00.000Z",
    );
    // Vostok's one-off two-hour wind-back, UTC+7 to UTC+5.
    expect(shopDateToInstant("2023-12-18", "Antarctica/Vostok").toISOString()).toBe(
      "2023-12-17T17:00:00.000Z",
    );
  });

  it("applies a back-dated cost from the first minute of the doubled day", () => {
    const newCost = cost({
      id: "autumn",
      effectiveFrom: shopDateToInstant("2021-10-29", "Asia/Amman").toISOString(),
      unitCostCents: 1100,
    });
    const backdated = cost({
      id: "old",
      effectiveFrom: "2021-01-01T00:00:00.000Z",
      unitCostCents: 800,
      createdAt: new Date("2021-01-01T00:00:00.000Z"),
    });
    const rows = [backdated, newCost];
    // 23:30 on the 28th in Amman (still UTC+3) — the new day has not started.
    expect(resolveCostAt(rows, new Date("2021-10-28T20:30:00.000Z"))?.unitCostCents).toBe(800);
    // 00:30 on the 29th, first time round: already the new cost.
    expect(resolveCostAt(rows, new Date("2021-10-28T21:30:00.000Z"))?.unitCostCents).toBe(1100);
    // 00:30 on the 29th, second time round, after the clocks wound back.
    expect(resolveCostAt(rows, new Date("2021-10-28T22:30:00.000Z"))?.unitCostCents).toBe(1100);
  });
});

/**
 * The property the conversion has to hold: the instant stored in
 * `effective_from` is the *first* instant of the requested date in the shop's
 * zone. Checked against a search that knows nothing about the implementation,
 * over zones that jump forward at midnight (Santiago, Havana), that wind back
 * to midnight so the hour repeats (Amman, Gaza, Hebron, Casey, Vostok), that
 * shift at 02:00 (US, Europe), at 03:00 (Auckland), at 01:00 UTC (Azores,
 * which is also a midnight jump locally), by 30 minutes (Lord Howe), by 45
 * (Chatham), and zones that never shift at all.
 *
 * The windows matter as much as the zones: every wind-back to midnight is
 * historic (the last is Vostok in December 2023), so a future-only window
 * cannot see one, and back-dating a cost reaches them.
 */
describe("shopDateToInstant against a brute-force reference", () => {
  const ZONES = [
    "UTC",
    "America/New_York",
    "America/Los_Angeles",
    "America/Santiago",
    "America/Havana",
    "America/Sao_Paulo",
    "America/Asuncion",
    "America/St_Johns",
    "America/Nuuk",
    "Atlantic/Azores",
    "Pacific/Auckland",
    "Pacific/Chatham",
    "Pacific/Apia",
    "Pacific/Fiji",
    "Australia/Lord_Howe",
    "Australia/Sydney",
    "Europe/London",
    "Europe/Berlin",
    "Europe/Lisbon",
    "Asia/Kolkata",
    "Asia/Kathmandu",
    "Asia/Tehran",
    "Asia/Jerusalem",
    "Asia/Beirut",
    "Asia/Amman",
    "Asia/Gaza",
    "Asia/Hebron",
    "Africa/Cairo",
    "Antarctica/Troll",
    "Antarctica/Casey",
    "Antarctica/Vostok",
  ];
  const MINUTE = 60_000;
  const HALF_HOUR = 30 * MINUTE;
  const dateFormatters = new Map<string, Intl.DateTimeFormat>();

  function localDate(ms: number, timeZone: string): string {
    let fmt = dateFormatters.get(timeZone);
    if (!fmt) {
      // en-CA formats as YYYY-MM-DD.
      fmt = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
      dateFormatters.set(timeZone, fmt);
    }
    return fmt.format(new Date(ms));
  }

  /**
   * Search, rather than compute, the earliest instant the zone calls `date`:
   * a half-hourly sweep to land inside the day (no offset shift is that
   * narrow), then a minute-by-minute walk back to its first minute.
   */
  function firstInstantOfLocalDate(date: string, timeZone: string): number {
    const [y, mo, d] = date.split("-").map(Number);
    const utcMidnight = Date.UTC(y, mo - 1, d);
    for (
      let ms = utcMidnight - 26 * 3_600_000;
      ms <= utcMidnight + 26 * 3_600_000;
      ms += HALF_HOUR
    ) {
      if (localDate(ms, timeZone) !== date) continue;
      for (let back = ms - HALF_HOUR + MINUTE; back <= ms; back += MINUTE) {
        if (localDate(back, timeZone) === date) return back;
      }
      return ms;
    }
    throw new Error(`No instant found for ${date} in ${timeZone}`);
  }

  // 2019-2023 for the wind-backs to midnight (Amman, Gaza and Hebron each
  // October to 2021; Casey in March 2019, 2020 and 2023; Vostok in December
  // 2023), 2026-2027 for the forward jumps. Each window spans whole years, so
  // both of a zone's yearly transitions are covered in either hemisphere.
  const WINDOWS = [
    { from: Date.UTC(2019, 0, 1), days: 1826 },
    { from: Date.UTC(2026, 0, 1), days: 730 },
  ];

  it("returns the earliest instant whose shop-local date is the one asked for", () => {
    const mismatches: string[] = [];
    for (const timeZone of ZONES) {
      for (const { from, days } of WINDOWS) {
        for (let day = 0; day < days; day++) {
          const date = new Date(from + day * 86_400_000).toISOString().slice(0, 10);
          const actual = shopDateToInstant(date, timeZone).getTime();
          const expected = firstInstantOfLocalDate(date, timeZone);
          if (actual !== expected) {
            mismatches.push(
              `${timeZone} ${date}: got ${new Date(actual).toISOString()}, ` +
                `first instant of that day is ${new Date(expected).toISOString()}`,
            );
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});
