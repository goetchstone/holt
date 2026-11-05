// /app/__tests__/agedStock.test.ts
//
// The pure parts of GAP-17: which arrivals account for what's on hand, the age
// buckets, the report's shape for each viewer, and where a place stands against
// its counting schedule.

import { MOVEMENT_REASONS, type MovementReason } from "@/lib/inventory/ledger";
import {
  AGE_EFFECT,
  ARRIVAL_LABELS,
  AGED_PRODUCT_LIMIT,
  agedStockForCaller,
  layersOnHand,
  summarizeAgedStock,
  type AgedStockProduct,
  type JournalArrival,
} from "@/lib/reports/agedStock";
import { AGE_BUCKETS, ageBucketIndex } from "@/lib/reports/agedStockShared";
import { addDays, businessDayStart, daysBetween } from "@/lib/reports/businessDay";
import { TRANSFER_STATUS_LABELS, TRANSFER_VIEWS } from "@/lib/reports/transfersReportShared";
import {
  countEveryDaysProblem,
  countStanding,
  COUNT_EVERY_DAYS_MAX,
  sortSchedule,
  type ScheduledCount,
} from "@/lib/inventory/countSchedule";

const row = (reason: MovementReason, quantity: number, day: string): JournalArrival => ({
  reason,
  quantity,
  occurredAt: new Date(`${day}T15:00:00.000Z`),
});

describe("AGE_EFFECT", () => {
  it("says what every journal reason does to age, and names no other", () => {
    expect(Object.keys(AGE_EFFECT).sort()).toEqual(Object.keys(MOVEMENT_REASONS).sort());
  });

  it("every reason that starts an age has a label for the report", () => {
    const starts = Object.entries(AGE_EFFECT)
      .filter(([, e]) => e === "starts")
      .map(([r]) => r);
    expect(Object.keys(ARRIVAL_LABELS).sort()).toEqual(starts.sort());
  });
});

describe("layersOnHand", () => {
  it("takes the newest arrivals first and stops when they cover what's here", () => {
    const { layers, noRecord } = layersOnHand(4, [
      row("RECEIVE", 3, "2026-10-01"),
      row("RECEIVE", 5, "2026-01-01"),
      row("OPENING", 9, "2025-01-01"),
    ]);
    expect(layers.map((l) => l.units)).toEqual([3, 1]);
    expect(noRecord).toBe(0);
  });

  it("handles fractional yards without leaving dust behind", () => {
    const { layers, noRecord } = layersOnHand(0.3, [
      row("RECEIVE", 0.1, "2026-10-02"),
      row("RECEIVE", 0.2, "2026-10-01"),
    ]);
    expect(layers.map((l) => l.units)).toEqual([0.1, 0.2]);
    expect(noRecord).toBe(0);
  });

  it("reports what no arrival accounts for", () => {
    expect(layersOnHand(5, [row("RECEIVE", 3, "2026-10-01")]).noRecord).toBe(2);
    expect(layersOnHand(5, []).noRecord).toBe(5);
  });

  it("a receipt taken back cancels the receipt before it, in part or whole", () => {
    const { layers } = layersOnHand(4, [
      row("UNRECEIVE", 2, "2026-10-03"),
      row("RECEIVE", 3, "2026-10-02"),
      row("RECEIVE", 9, "2026-01-01"),
    ]);
    expect(layers.map((l) => [l.occurredAt.toISOString().slice(0, 10), l.units])).toEqual([
      ["2026-10-02", 1],
      ["2026-01-01", 3],
    ]);
  });

  it("only a receipt can be taken back, so a return in between isn't cancelled", () => {
    const { layers } = layersOnHand(2, [
      row("UNRECEIVE", 1, "2026-10-03"),
      row("RETURN", 1, "2026-10-02"),
      row("RECEIVE", 1, "2026-10-01"),
      row("RECEIVE", 1, "2026-01-01"),
    ]);
    expect(layers.map((l) => [l.reason, l.occurredAt.toISOString().slice(0, 10)])).toEqual([
      ["RETURN", "2026-10-02"],
      ["RECEIVE", "2026-01-01"],
    ]);
  });

  it("takes back more than one receipt if it has to", () => {
    const { layers, noRecord } = layersOnHand(1, [
      row("UNRECEIVE", 3, "2026-10-03"),
      row("RECEIVE", 1, "2026-10-02"),
      row("RECEIVE", 2, "2026-10-01"),
      row("RECEIVE", 1, "2026-01-01"),
    ]);
    expect(layers.map((l) => l.occurredAt.toISOString().slice(0, 10))).toEqual(["2026-01-01"]);
    expect(noRecord).toBe(0);
  });
});

describe("ageBucketIndex", () => {
  it.each([
    [0, 0],
    [90, 0],
    [91, 1],
    [180, 1],
    [181, 2],
    [365, 2],
    [366, 3],
    [5000, 3],
  ])("%i days goes in bucket %i", (days, bucket) => {
    expect(ageBucketIndex(days)).toBe(bucket);
  });

  it("matches the labels", () => {
    expect(AGE_BUCKETS.map((b) => b.label)).toEqual([
      "0-90 days",
      "91-180 days",
      "181-365 days",
      "Over a year",
    ]);
  });
});

describe("daysBetween", () => {
  it("counts whole days, across a clock change, and backwards", () => {
    expect(daysBetween("2026-03-07", "2026-03-09")).toBe(2);
    expect(daysBetween("2026-11-01", "2026-11-02")).toBe(1);
    expect(daysBetween("2026-01-02", "2026-01-01")).toBe(-1);
    expect(daysBetween("2026-05-05", addDays("2026-05-05", 365))).toBe(365);
  });
});

const NY = "America/New_York";
const TODAY = "2026-11-04";

function product(over: Partial<AgedStockProduct> & { productId: number }): AgedStockProduct {
  return {
    productNumber: `P${over.productId}`,
    name: `Product ${over.productId}`,
    group: "G",
    units: 1,
    unitCost: 10,
    unitRetail: 20,
    ...over,
  };
}

const meta = { pivot: "department" as const, today: TODAY, timeZone: NY, committedUnits: 0 };

describe("summarizeAgedStock", () => {
  it("dates a unit by the store's day, not UTC's", () => {
    // 2026-08-08 20:00 Eastern is 00:00Z on the 9th.
    const lateEvening = businessDayStart("2026-08-09", "UTC");
    const { oldest } = summarizeAgedStock(
      [product({ productId: 1 })],
      new Map([[1, [{ reason: "RECEIVE", quantity: 1, occurredAt: lateEvening }]]]),
      meta,
    );
    expect(oldest[0].oldestOn).toBe("2026-08-08");
    expect(oldest[0].oldestDays).toBe(daysBetween("2026-08-08", TODAY));
  });

  it("rounds money but keeps the groups and the totals adding up", () => {
    const result = summarizeAgedStock(
      [
        product({ productId: 1, group: "A", units: 3, unitCost: 0.333, unitRetail: 1.115 }),
        product({ productId: 2, group: "B", units: 1, unitCost: 5, unitRetail: 9 }),
      ],
      new Map([
        [1, [row("RECEIVE", 3, "2026-11-01")]],
        [2, [row("RECEIVE", 1, "2026-11-01")]],
      ]),
      meta,
    );
    expect(result.rows.map((r) => r.key)).toEqual(["B", "A"]);
    expect(result.rows[1].costValue).toBe(1);
    expect(result.totals.costValue).toBe(6);
    expect(result.totals.retailValue).toBe(12.35);
  });

  it("orders groups by cost, then name, and keeps a stable order on a tie", () => {
    const result = summarizeAgedStock(
      [product({ productId: 1, group: "Zed" }), product({ productId: 2, group: "Abe" })],
      new Map(),
      meta,
    );
    expect(result.rows.map((r) => r.key)).toEqual(["Abe", "Zed"]);
  });

  it("treats a product with no retail or cost as worth nothing, and flags the cost", () => {
    const { totals } = summarizeAgedStock(
      [product({ productId: 1, units: 2, unitCost: null, unitRetail: null })],
      new Map([[1, [row("RECEIVE", 2, "2026-11-01")]]]),
      meta,
    );
    expect(totals).toMatchObject({ costValue: 0, retailValue: 0, uncostedUnits: 2 });
  });

  it("lists at most the limit, oldest first, and says how many there are", () => {
    const products = Array.from({ length: AGED_PRODUCT_LIMIT + 3 }, (_, i) =>
      product({ productId: i + 1 }),
    );
    const arrivals = new Map(
      products.map((p) => [
        p.productId,
        [row("RECEIVE", 1, addDays(TODAY, -p.productId))] as JournalArrival[],
      ]),
    );
    const { oldest, productCount } = summarizeAgedStock(products, arrivals, meta);
    expect(oldest).toHaveLength(AGED_PRODUCT_LIMIT);
    expect(productCount).toBe(AGED_PRODUCT_LIMIT + 3);
    expect(oldest[0].productId).toBe(AGED_PRODUCT_LIMIT + 3);
  });

  it("leaves a product no arrival accounts for off the oldest list", () => {
    const { oldest, totals } = summarizeAgedStock([product({ productId: 1 })], new Map(), meta);
    expect(oldest).toEqual([]);
    expect(totals.noRecordUnits).toBe(1);
  });
});

describe("agedStockForCaller", () => {
  const result = summarizeAgedStock(
    [
      product({ productId: 1, group: "Costly", unitCost: 90, unitRetail: 100 }),
      product({ productId: 2, group: "Pretty", unitCost: 5, unitRetail: 300 }),
    ],
    new Map([
      [1, [row("RECEIVE", 1, "2026-10-01")]],
      [2, [row("RECEIVE", 1, "2026-10-01")]],
    ]),
    meta,
  );

  it("is whole for a holder", () => {
    expect(agedStockForCaller(result, true)).toEqual({ ...result, costVisible: true });
  });

  it("takes cost off everything for anyone else, and doesn't give cost order away", () => {
    const shown = agedStockForCaller(result, false);
    expect(JSON.stringify(shown)).not.toMatch(/costValue|uncostedUnits/);
    expect(shown.rows.map((r) => r.key)).toEqual(["Pretty", "Costly"]);
    expect(shown.totals.units).toBe(2);
    expect(shown.oldest).toHaveLength(2);
  });
});

describe("the Transfers report's views", () => {
  it("names only real statuses, and every status has a label", () => {
    const named = Object.values(TRANSFER_VIEWS).flatMap((v) => [...v.statuses]);
    for (const status of named) expect(TRANSFER_STATUS_LABELS[status]).toBeDefined();
  });
});

describe("countEveryDaysProblem", () => {
  it("allows a whole number of days in range, and clearing it", () => {
    expect(countEveryDaysProblem(1, "STOCK")).toBeNull();
    expect(countEveryDaysProblem(COUNT_EVERY_DAYS_MAX, "STOCK")).toBeNull();
    expect(countEveryDaysProblem(null, "GROUP")).toBeNull();
    expect(countEveryDaysProblem(undefined, "GROUP")).toBeNull();
  });

  it.each([0, -3, 2.5, COUNT_EVERY_DAYS_MAX + 1, "30", Number.NaN])("refuses %p", (bad) => {
    expect(countEveryDaysProblem(bad, "STOCK")).toMatch(/whole number of days/);
  });

  it("refuses a place that can't be counted", () => {
    expect(countEveryDaysProblem(30, "GROUP")).toMatch(/groups other places/);
    expect(countEveryDaysProblem(30, "FLOOR")).toBeNull();
  });
});

describe("countStanding", () => {
  const today = "2026-11-04";
  const standing = (lastCountedOn: string | null, waitingToPost = false) =>
    countStanding({ everyDays: 30, lastCountedOn, waitingToPost, today });

  it("is due now when never counted", () => {
    expect(standing(null)).toEqual({ dueOn: null, standing: "DUE", daysLate: 0 });
  });

  it("isn't yet the day before", () => {
    expect(standing(addDays(today, -29))).toMatchObject({
      standing: "NOT_YET",
      dueOn: addDays(today, 1),
      daysLate: 0,
    });
  });

  it("is due on the day", () => {
    expect(standing(addDays(today, -30))).toMatchObject({ standing: "DUE", dueOn: today });
  });

  it("is late the day after, by the days it's late", () => {
    expect(standing(addDays(today, -31))).toMatchObject({ standing: "OVERDUE", daysLate: 1 });
    expect(standing(addDays(today, -90))).toMatchObject({ standing: "OVERDUE", daysLate: 60 });
  });

  it("waits on a count to post only once it's due", () => {
    expect(standing(null, true).standing).toBe("WAITING");
    expect(standing(addDays(today, -40), true)).toMatchObject({ standing: "WAITING", daysLate: 0 });
    expect(standing(addDays(today, -1), true).standing).toBe("NOT_YET");
  });
});

describe("sortSchedule", () => {
  const row2 = (place: string, over: Partial<ScheduledCount>): ScheduledCount => ({
    stockLocationId: 1,
    code: place,
    place,
    store: "S",
    everyDays: 30,
    lastCountedOn: null,
    dueOn: null,
    standing: "DUE",
    daysLate: 0,
    ...over,
  });

  it("goes latest first, then never counted, then due, then waiting, then soonest", () => {
    const sorted = sortSchedule([
      row2("later", { standing: "NOT_YET", dueOn: "2026-12-30" }),
      row2("soon", { standing: "NOT_YET", dueOn: "2026-11-10" }),
      row2("waiting", { standing: "WAITING" }),
      row2("today", { standing: "DUE", dueOn: "2026-11-04" }),
      row2("never", { standing: "DUE", dueOn: null }),
      row2("late", { standing: "OVERDUE", daysLate: 2 }),
      row2("very late", { standing: "OVERDUE", daysLate: 40 }),
    ]);
    expect(sorted.map((r) => r.place)).toEqual([
      "very late",
      "late",
      "never",
      "today",
      "waiting",
      "soon",
      "later",
    ]);
  });

  it("breaks ties by store, then place", () => {
    const sorted = sortSchedule([
      row2("B", { store: "Z" }),
      row2("B", { store: "A" }),
      row2("A", { store: "A" }),
    ]);
    expect(sorted.map((r) => `${r.store}${r.place}`)).toEqual(["AA", "AB", "ZB"]);
  });
});
