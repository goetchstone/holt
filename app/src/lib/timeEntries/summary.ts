// /app/src/lib/timeEntries/summary.ts
//
// Pure roll-up of time entries into total / billable / unbilled-billable
// minutes. Used by the time-tracking view header. No I/O.

export interface TimeEntryLike {
  minutes: number;
  isBillable: boolean;
  billedAt?: Date | string | null;
}

export interface TimeSummary {
  count: number;
  totalMinutes: number;
  billableMinutes: number;
  unbilledBillableMinutes: number;
}

export function summarizeTimeEntries(entries: readonly TimeEntryLike[]): TimeSummary {
  let totalMinutes = 0;
  let billableMinutes = 0;
  let unbilledBillableMinutes = 0;
  for (const e of entries) {
    totalMinutes += e.minutes;
    if (e.isBillable) {
      billableMinutes += e.minutes;
      if (!e.billedAt) unbilledBillableMinutes += e.minutes;
    }
  }
  return { count: entries.length, totalMinutes, billableMinutes, unbilledBillableMinutes };
}
