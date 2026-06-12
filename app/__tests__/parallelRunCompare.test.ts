// /app/__tests__/parallelRunCompare.test.ts
//
// Pure tests for the parallel-run compare helpers (scripts/parallel-run-compare.cjs).
// The script is the trust gate before a legacy cutover — a wrong diff here
// either blocks a clean cutover or, worse, blesses a drifting one.

/* eslint-disable @typescript-eslint/no-require-imports */
const {
  listDays,
  diffDayTotals,
  diffStores,
  parseArgs,
} = require("../../scripts/parallel-run-compare.cjs");

describe("listDays", () => {
  it("lists an inclusive UTC day range", () => {
    expect(listDays("2026-06-01", "2026-06-03")).toEqual([
      "2026-06-01",
      "2026-06-02",
      "2026-06-03",
    ]);
  });

  it("handles a single day and month boundaries", () => {
    expect(listDays("2026-06-05", "2026-06-05")).toEqual(["2026-06-05"]);
    expect(listDays("2026-05-30", "2026-06-01")).toEqual(["2026-05-30", "2026-05-31", "2026-06-01"]);
  });

  it("rejects inverted or malformed ranges", () => {
    expect(() => listDays("2026-06-03", "2026-06-01")).toThrow(/Invalid date range/);
    expect(() => listDays("junk", "2026-06-01")).toThrow(/Invalid date range/);
  });
});

describe("diffDayTotals", () => {
  const day = (revenue: number, tax: number, cash: number, orders: number) => ({
    revenue,
    tax,
    cash,
    orders,
  });

  it("is balanced when every field matches within tolerance", () => {
    const { drift, balanced } = diffDayTotals(
      day(1000.01, 63.5, 500, 12),
      day(1000, 63.5, 500, 12),
      0.01,
    );
    expect(balanced).toBe(true);
    expect(drift.revenue).toBeCloseTo(0.01, 5);
  });

  it("flags revenue drift beyond tolerance with signed holt-minus-legacy", () => {
    const { drift, balanced } = diffDayTotals(day(900, 0, 0, 5), day(1000, 0, 0, 5), 0.01);
    expect(balanced).toBe(false);
    expect(drift.revenue).toBe(-100);
  });

  it("treats ANY order-count mismatch as drift even when dollars tie", () => {
    const { drift, balanced } = diffDayTotals(day(1000, 0, 0, 13), day(1000, 0, 0, 12), 0.01);
    expect(balanced).toBe(false);
    expect(drift.orders).toBe(1);
  });

  it("flags cash drift independently of revenue", () => {
    const { balanced, drift } = diffDayTotals(day(1000, 0, 250, 5), day(1000, 0, 400, 5), 0.01);
    expect(balanced).toBe(false);
    expect(drift.cash).toBe(-150);
  });
});

describe("diffStores", () => {
  it("aligns stores present on either side and reports only drifted ones", () => {
    const holt = [
      { store: "Old Saybrook", revenue: 1000 },
      { store: "Glastonbury", revenue: 500 },
    ];
    const legacy = [
      { store: "Old Saybrook", revenue: 1000 },
      { store: "Cheshire", revenue: 75 },
    ];
    const rows = diffStores(holt, legacy, 0.01);
    expect(rows).toEqual([
      { store: "Cheshire", holt: 0, legacy: 75, drift: -75 },
      { store: "Glastonbury", holt: 500, legacy: 0, drift: 500 },
    ]);
  });

  it("returns empty when everything ties", () => {
    const rows = [{ store: "A", revenue: 10 }];
    expect(diffStores(rows, rows, 0.01)).toEqual([]);
  });
});

describe("parseArgs", () => {
  it("parses an explicit range + flags", () => {
    const args = parseArgs(["--from", "2026-06-01", "--to", "2026-06-07", "--by-store"]);
    expect(args).toMatchObject({ from: "2026-06-01", to: "2026-06-07", byStore: true });
  });

  it("defaults to the last 7 full days ending yesterday", () => {
    const args = parseArgs([]);
    expect(listDays(args.from, args.to)).toHaveLength(7);
    expect(args.to < new Date().toISOString().slice(0, 10)).toBe(true);
  });

  it("rejects unknown flags and bad tolerance", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/Unknown flag/);
    expect(() => parseArgs(["--tolerance", "-1"])).toThrow(/tolerance/);
  });
});
