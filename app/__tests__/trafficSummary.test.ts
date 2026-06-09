// /app/__tests__/trafficSummary.test.ts
//
// Pure tests for the Axper-traffic rollup helpers. The fixture
// represents a small slice of two days × two stores at 15-min
// granularity — enough to pin every aggregate shape.

import {
  rollupByDay,
  rollupByStore,
  rollupByDayAndStore,
  rollupByHour,
  rollupByDayOfWeek,
  totalVisitors,
  conversionRate,
  type TrafficRowForSummary,
} from "../src/lib/trafficSummary";

function row(
  date: string,
  store: string,
  visitors: number,
  exits: number | null = null,
  storeLocationId: number | null = null,
): TrafficRowForSummary {
  return {
    intervalStart: new Date(date),
    axperStoreName: store,
    storeLocationId,
    visitors,
    exits,
  };
}

describe("rollupByDay", () => {
  it("returns [] for empty input", () => {
    expect(rollupByDay([])).toEqual([]);
  });

  it("sums visitors by calendar day across stores", () => {
    const rows = [
      row("2026-05-27T10:00:00", "Glastonbury", 5),
      row("2026-05-27T10:15:00", "Glastonbury", 7),
      row("2026-05-27T10:00:00", "NB", 3),
      row("2026-05-28T11:00:00", "Glastonbury", 10),
    ];
    expect(rollupByDay(rows)).toEqual([
      { date: "2026-05-27", visitors: 15, exits: null },
      { date: "2026-05-28", visitors: 10, exits: null },
    ]);
  });

  it("sums exits when present, returns null when all rows have null exits", () => {
    const rows = [
      row("2026-05-27T10:00:00", "Glastonbury", 5, 4),
      row("2026-05-27T10:15:00", "Glastonbury", 7, 6),
      row("2026-05-28T10:00:00", "Glastonbury", 3, null), // mixed
      row("2026-05-28T10:15:00", "Glastonbury", 2, 1),
    ];
    const out = rollupByDay(rows);
    expect(out[0].exits).toBe(10); // 4 + 6
    expect(out[1].exits).toBe(1); // 0 (treated null as 0) + 1
  });

  it("sorts oldest first", () => {
    const rows = [
      row("2026-05-29T10:00:00", "A", 1),
      row("2026-05-27T10:00:00", "A", 1),
      row("2026-05-28T10:00:00", "A", 1),
    ];
    expect(rollupByDay(rows).map((r) => r.date)).toEqual([
      "2026-05-27",
      "2026-05-28",
      "2026-05-29",
    ]);
  });
});

describe("rollupByStore", () => {
  it("sums by store across all days, sorted busiest first", () => {
    const rows = [
      row("2026-05-27T10:00:00", "Glastonbury", 10),
      row("2026-05-28T10:00:00", "Glastonbury", 5),
      row("2026-05-27T10:00:00", "NB", 20),
      row("2026-05-27T10:00:00", "Cheshire", 2),
    ];
    expect(rollupByStore(rows)).toEqual([
      { axperStoreName: "NB", storeLocationId: null, visitors: 20, exits: null },
      { axperStoreName: "Glastonbury", storeLocationId: null, visitors: 15, exits: null },
      { axperStoreName: "Cheshire", storeLocationId: null, visitors: 2, exits: null },
    ]);
  });

  it("preserves storeLocationId from the first row seen for that store", () => {
    const rows = [
      row("2026-05-27T10:00:00", "Glastonbury", 5, null, 1),
      row("2026-05-27T10:15:00", "Glastonbury", 7, null, 1),
    ];
    expect(rollupByStore(rows)[0].storeLocationId).toBe(1);
  });
});

describe("rollupByDayAndStore", () => {
  it("produces one row per (day, store) sorted by date asc + visitors desc within day", () => {
    const rows = [
      row("2026-05-27T10:00:00", "Glastonbury", 10),
      row("2026-05-27T10:00:00", "NB", 20),
      row("2026-05-28T10:00:00", "Glastonbury", 30),
      row("2026-05-28T10:00:00", "NB", 5),
    ];
    expect(rollupByDayAndStore(rows)).toEqual([
      {
        date: "2026-05-27",
        axperStoreName: "NB",
        storeLocationId: null,
        visitors: 20,
        exits: null,
      },
      {
        date: "2026-05-27",
        axperStoreName: "Glastonbury",
        storeLocationId: null,
        visitors: 10,
        exits: null,
      },
      {
        date: "2026-05-28",
        axperStoreName: "Glastonbury",
        storeLocationId: null,
        visitors: 30,
        exits: null,
      },
      {
        date: "2026-05-28",
        axperStoreName: "NB",
        storeLocationId: null,
        visitors: 5,
        exits: null,
      },
    ]);
  });
});

describe("totalVisitors", () => {
  it("returns 0 / null for empty input", () => {
    expect(totalVisitors([])).toEqual({ visitors: 0, exits: null });
  });

  it("sums visitors + exits across every row", () => {
    const rows = [
      row("2026-05-27T10:00:00", "A", 5, 4),
      row("2026-05-27T10:15:00", "A", 7, 6),
      row("2026-05-28T10:00:00", "B", 3, null),
    ];
    expect(totalVisitors(rows)).toEqual({ visitors: 15, exits: 10 });
  });
});

describe("conversionRate", () => {
  it("returns transactions / visitors when visitors > 0", () => {
    expect(conversionRate(5, 100)).toBe(0.05);
  });

  it("returns null when visitors === 0 (avoid Infinity)", () => {
    expect(conversionRate(5, 0)).toBeNull();
  });

  it("returns null when visitors is negative (defensive)", () => {
    expect(conversionRate(5, -10)).toBeNull();
  });

  it("returns 0 when transactions === 0 and visitors > 0", () => {
    expect(conversionRate(0, 100)).toBe(0);
  });
});

describe("rollupByHour", () => {
  it("returns 24 rows, zero-filled, regardless of input", () => {
    const out = rollupByHour([]);
    expect(out).toHaveLength(24);
    expect(out.every((r) => r.visitors === 0)).toBe(true);
    expect(out.map((r) => r.hour)).toEqual(Array.from({ length: 24 }, (_, i) => i));
  });

  it("sums by hour-of-day across multiple days + stores", () => {
    // 09:00 — both stores
    // 10:30 — store A only
    // 14:15 — store B only
    // Tomorrow same shape, different counts
    const rows: TrafficRowForSummary[] = [
      row("2026-05-26T09:00:00", "NB", 5),
      row("2026-05-26T09:00:00", "SB", 3),
      row("2026-05-26T10:30:00", "NB", 7),
      row("2026-05-26T14:15:00", "SB", 11),
      row("2026-05-27T09:00:00", "NB", 2),
      row("2026-05-27T10:30:00", "SB", 4),
    ];
    const out = rollupByHour(rows);
    // 9 AM: 5+3+2 = 10
    expect(out[9].visitors).toBe(10);
    // 10 AM: 7+4 = 11
    expect(out[10].visitors).toBe(11);
    // 14: 11
    expect(out[14].visitors).toBe(11);
    // All other hours: 0
    expect(out[8].visitors).toBe(0);
    expect(out[11].visitors).toBe(0);
    expect(out[12].visitors).toBe(0);
    expect(out[13].visitors).toBe(0);
    expect(out[15].visitors).toBe(0);
    expect(out[23].visitors).toBe(0);
  });
});

describe("rollupByDayOfWeek", () => {
  it("returns 7 rows Sun..Sat, zero-filled", () => {
    const out = rollupByDayOfWeek([]);
    expect(out).toHaveLength(7);
    expect(out.map((r) => r.dow)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(out.every((r) => r.visitors === 0)).toBe(true);
  });

  it("sums by day-of-week regardless of which calendar week the row falls in", () => {
    // 2026-05-25 was a Monday (dow=1); 2026-05-26 was Tuesday (dow=2);
    // 2026-05-30 was Saturday (dow=6); 2026-05-31 was Sunday (dow=0).
    const rows: TrafficRowForSummary[] = [
      row("2026-05-25T10:00:00", "NB", 10), // Mon
      row("2026-05-26T10:00:00", "NB", 20), // Tue
      row("2026-05-30T10:00:00", "NB", 30), // Sat
      row("2026-05-31T10:00:00", "NB", 40), // Sun
      // Week 2 — same days-of-week, accumulate
      row("2026-06-01T10:00:00", "NB", 5), // Mon
      row("2026-06-07T10:00:00", "NB", 50), // Sun
    ];
    const out = rollupByDayOfWeek(rows);
    expect(out[0].visitors).toBe(90); // Sun: 40 + 50
    expect(out[1].visitors).toBe(15); // Mon: 10 + 5
    expect(out[2].visitors).toBe(20); // Tue
    expect(out[3].visitors).toBe(0); // Wed
    expect(out[4].visitors).toBe(0); // Thu
    expect(out[5].visitors).toBe(0); // Fri
    expect(out[6].visitors).toBe(30); // Sat
  });
});
