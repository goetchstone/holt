// /app/__tests__/followUpReport.test.ts
//
// The Follow-Ups report's filters and per-salesperson summary (GAP-36).

import {
  DEFAULT_FOLLOW_UP_FILTERS,
  filterFollowUpRows,
  summarizeFollowUps,
  type FollowUpRow,
} from "@/lib/followUpReport";

function row(over: Partial<FollowUpRow> = {}): FollowUpRow {
  return {
    customerId: 1,
    clientName: "Nora Vale",
    ownerId: 1,
    owner: "Pat Lund",
    store: "Main Street",
    nextFollowUpDate: "2026-11-05",
    status: "due",
    lastContact: null,
    lastNote: null,
    phone: null,
    email: null,
    openQuotes: 0,
    openQuoteValue: 0,
    lifetimeSpend: 0,
    closeLikelihood: null,
    projectTimeline: null,
    budgetRange: null,
    ...over,
  };
}

describe("filterFollowUpRows", () => {
  const due = row({ customerId: 1, status: "due" });
  const scheduled = row({ customerId: 2, status: "scheduled", nextFollowUpDate: "2026-11-20" });
  const done = row({ customerId: 3, status: "done", nextFollowUpDate: "2026-10-01" });
  const elsewhere = row({ customerId: 4, owner: "Sam Reed", store: "Harbor Road" });
  const all = [due, scheduled, done, elsewhere];
  const ids = (filters: Partial<typeof DEFAULT_FOLLOW_UP_FILTERS>) =>
    filterFollowUpRows(all, { ...DEFAULT_FOLLOW_UP_FILTERS, ...filters }).map((r) => r.customerId);

  it("shows what's outstanding by default, leaving out what's done", () => {
    expect(ids({})).toEqual([1, 2, 4]);
  });

  it("filters by status", () => {
    expect(ids({ status: "due" })).toEqual([1, 4]);
    expect(ids({ status: "scheduled" })).toEqual([2]);
    expect(ids({ status: "done" })).toEqual([3]);
    expect(ids({ status: "all" })).toEqual([1, 2, 3, 4]);
  });

  it("filters by salesperson and store", () => {
    expect(ids({ owner: "Sam Reed" })).toEqual([4]);
    expect(ids({ store: "Harbor Road" })).toEqual([4]);
    expect(ids({ store: "Main Street", status: "all" })).toEqual([1, 2, 3]);
  });

  it("filters by date, including both ends", () => {
    expect(ids({ from: "2026-11-05", to: "2026-11-05" })).toEqual([1, 4]);
    expect(ids({ from: "2026-11-06" })).toEqual([2]);
    expect(ids({ to: "2026-11-04", status: "all" })).toEqual([3]);
  });
});

describe("summarizeFollowUps", () => {
  it("counts what's outstanding per person, and leaves what's done out of it", () => {
    const summary = summarizeFollowUps(
      [
        row({ status: "due", openQuoteValue: 100 }),
        row({ status: "scheduled", openQuoteValue: 50 }),
        row({ status: "done", openQuoteValue: 999 }),
      ],
      [],
    );
    expect(summary).toEqual([
      {
        owner: "Pat Lund",
        due: 1,
        scheduled: 1,
        openQuoteValue: 150,
        contactsLogged: 0,
        aboutClientNotQuote: 0,
      },
    ]);
  });

  it("shows anyone with logged contacts, even with no dates set", () => {
    const summary = summarizeFollowUps(
      [],
      [{ owner: "Sam Reed", contactsLogged: 4, aboutClientNotQuote: 3 }],
    );
    expect(summary).toEqual([
      {
        owner: "Sam Reed",
        due: 0,
        scheduled: 0,
        openQuoteValue: 0,
        contactsLogged: 4,
        aboutClientNotQuote: 3,
      },
    ]);
  });

  it("puts the most due first, then the most scheduled, then by name", () => {
    const summary = summarizeFollowUps(
      [
        row({ owner: "Few", status: "scheduled" }),
        row({ owner: "Most", status: "due" }),
        row({ owner: "Many", status: "scheduled" }),
        row({ owner: "Many", status: "scheduled" }),
      ],
      [{ owner: "Alone", contactsLogged: 1, aboutClientNotQuote: 0 }],
    );
    expect(summary.map((s) => s.owner)).toEqual(["Most", "Many", "Few", "Alone"]);
  });
});
