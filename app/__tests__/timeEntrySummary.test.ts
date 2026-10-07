// /app/__tests__/timeEntrySummary.test.ts

import { summarizeTimeEntries } from "@/lib/timeEntries/summary";

describe("summarizeTimeEntries", () => {
  it("sums total, billable, and unbilled-billable minutes", () => {
    const summary = summarizeTimeEntries([
      { minutes: 60, isBillable: true, billedAt: null },
      { minutes: 30, isBillable: true, billedAt: "2026-06-01T00:00:00Z" },
      { minutes: 45, isBillable: false, billedAt: null },
    ]);
    expect(summary).toEqual({
      count: 3,
      totalMinutes: 135,
      billableMinutes: 90,
      unbilledBillableMinutes: 60,
    });
  });

  it("handles an empty list", () => {
    expect(summarizeTimeEntries([])).toEqual({
      count: 0,
      totalMinutes: 0,
      billableMinutes: 0,
      unbilledBillableMinutes: 0,
    });
  });
});
