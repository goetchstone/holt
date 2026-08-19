// /app/__tests__/unmappedPayments.test.ts
//
// The report exists because generateSalesJournal drops a payment whose
// `paymentType` has no POS_PAYMENTS mapping — it pushes a warning and
// `continue`s (lib/journalEntry.ts). These tests pin the two things that make
// the report agree with that behaviour, because if they drift the report
// reassures instead of warning:
//
//   1. Matching is LOWERCASED, exactly as journalEntry.ts does it. A deployment
//      whose mapping says "Cash" and whose payments say "CASH" is mapped, and
//      the report must not invent an exception.
//   2. A mapping row with no GL account is NOT a mapping. journalEntry.ts only
//      builds a lookup entry when the account resolves, so a label pointing at
//      nothing drops the payment just the same.

import { getUnmappedPayments } from "@/lib/reports/unmappedPayments";

type Mapping = { label: string; glAccountId: number | null };
type Group = {
  paymentType: string | null;
  _count: { _all: number };
  _sum: { paymentAmount: number | null };
  _min: { paymentDate: Date | null };
  _max: { paymentDate: Date | null };
};

function fakePrisma(mappings: Mapping[], groups: Group[], capture?: { where?: unknown }) {
  return {
    systemGLMapping: { findMany: async () => mappings },
    payment: {
      groupBy: async (args: { where?: unknown }) => {
        if (capture) capture.where = args.where;
        return groups;
      },
    },
  } as unknown as Parameters<typeof getUnmappedPayments>[0];
}

const g = (
  t: string | null,
  count: number,
  sum: number,
  from = "2026-01-02",
  to = "2026-06-30",
): Group => ({
  paymentType: t,
  _count: { _all: count },
  _sum: { paymentAmount: sum },
  _min: { paymentDate: new Date(`${from}T12:00:00Z`) },
  _max: { paymentDate: new Date(`${to}T12:00:00Z`) },
});

describe("getUnmappedPayments", () => {
  it("reports only tender types with no mapping", async () => {
    const r = await getUnmappedPayments(
      fakePrisma(
        [{ label: "Cash", glAccountId: 1 }],
        [g("Cash", 10, 100), g("Card Connect", 34027, 500000)],
      ),
    );
    expect(r.rows.map((x) => x.paymentType)).toEqual(["Card Connect"]);
    expect(r.totals).toEqual({ distinctTypes: 1, payments: 34027, amount: 500000 });
  });

  it("matches case-insensitively, exactly as the journal generator does", async () => {
    // journalEntry.ts keys its map on label.toLowerCase() and looks up
    // paymentType.toLowerCase().trim(). Anything stricter here invents an
    // exception the journal does not actually have.
    const r = await getUnmappedPayments(
      fakePrisma([{ label: "Cash", glAccountId: 1 }], [g("CASH", 5, 50), g(" cash ", 3, 30)]),
    );
    expect(r.rows).toEqual([]);
  });

  it("treats a mapping with no GL account as no mapping", async () => {
    // The generator only adds a lookup entry when the account resolves, so a
    // label pointing at nothing still drops the payment.
    const r = await getUnmappedPayments(
      fakePrisma([{ label: "Wire", glAccountId: null }], [g("Wire", 2, 2000)]),
    );
    expect(r.rows.map((x) => x.paymentType)).toEqual(["Wire"]);
  });

  it("ranks by absolute money, so the biggest gap is the first row", async () => {
    const r = await getUnmappedPayments(
      fakePrisma([], [g("Small", 100, 500), g("Refund", 3, -9000), g("Big", 2, 4000)]),
    );
    expect(r.rows.map((x) => x.paymentType)).toEqual(["Refund", "Big", "Small"]);
  });

  it("keeps amounts signed so a refund-only tender is not shown as income", async () => {
    const r = await getUnmappedPayments(fakePrisma([], [g("Refund", 3, -9000)]));
    expect(r.rows[0].totalAmount).toBe(-9000);
    expect(r.totals.amount).toBe(-9000);
  });

  it("lists configured labels that match no payment", async () => {
    const r = await getUnmappedPayments(
      fakePrisma(
        [
          { label: "AMEX", glAccountId: 1 },
          { label: "Visa", glAccountId: 2 },
          { label: "Cash", glAccountId: 3 },
        ],
        [g("Cash", 1, 10), g("Card Connect", 2, 20)],
      ),
    );
    expect(r.unusedMappingLabels).toEqual(["AMEX", "Visa"]);
  });

  it("defaults to ALL TIME — a window would answer the question wrongly", async () => {
    const cap: { where?: unknown } = {};
    await getUnmappedPayments(fakePrisma([], [], cap));
    expect(cap.where).toEqual({});
  });

  it("treats endDate as inclusive via a half-open upper bound", async () => {
    const cap: { where?: unknown } = {};
    await getUnmappedPayments(fakePrisma([], [], cap), {
      startDate: "2026-06-01",
      endDate: "2026-06-30",
    });
    expect(cap.where).toEqual({
      paymentDate: {
        gte: new Date("2026-06-01T00:00:00.000Z"),
        lt: new Date("2026-07-01T00:00:00.000Z"),
      },
    });
  });

  it("survives a null paymentType without crashing the report", async () => {
    const r = await getUnmappedPayments(fakePrisma([], [g(null, 4, 40)]));
    expect(r.rows[0].paymentType).toBe("");
    expect(r.totals.payments).toBe(4);
  });
});
