// /app/src/lib/booking/slots.ts
//
// Pure, deterministic availability-slot generator. No I/O, no clock access --
// the caller passes `fromDate` (typically `new Date()`) so the function is
// testable and reproducible. Emits fixed-length slots inside business hours for
// a number of days, dropping any slot that is in the past or overlaps a busy
// interval (existing bookings).

export interface BusyInterval {
  startsAt: Date;
  endsAt: Date;
}

export interface GenerateSlotsInput {
  /** Reference "now". Day 0 is this date's calendar day; past slots are dropped. */
  fromDate: Date;
  /** How many calendar days to generate, starting at fromDate's day. */
  days: number;
  /** Business-hours start, 0-23 (local time of the runtime). */
  startHour: number;
  /** Business-hours end, exclusive, 0-24. A slot must END by this hour. */
  endHour: number;
  /** Slot length in minutes. */
  slotMinutes: number;
  /** Intervals already taken; any slot overlapping one is excluded. */
  busy: BusyInterval[];
}

export interface Slot {
  startsAt: Date;
  endsAt: Date;
}

// Half-open overlap: [aStart, aEnd) intersects [bStart, bEnd). Touching edges
// (one ends exactly when the next begins) do NOT overlap, so back-to-back slots
// against adjacent bookings stay bookable.
function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export function generateSlots(input: GenerateSlotsInput): Slot[] {
  const { fromDate, days, startHour, endHour, slotMinutes, busy } = input;

  if (slotMinutes <= 0) return [];
  if (days <= 0) return [];
  if (endHour <= startHour) return [];

  const now = fromDate.getTime();
  const busyRanges = busy.map((b) => ({ start: b.startsAt.getTime(), end: b.endsAt.getTime() }));
  const slots: Slot[] = [];

  // Anchor to the start of fromDate's calendar day (local time) so "day N" is a
  // whole calendar day regardless of the time-of-day in fromDate.
  const dayCursor = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate());

  for (let day = 0; day < days; day++) {
    const base = new Date(dayCursor.getFullYear(), dayCursor.getMonth(), dayCursor.getDate() + day);

    for (let minute = startHour * 60; minute + slotMinutes <= endHour * 60; minute += slotMinutes) {
      const startsAt = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, minute);
      const endsAt = new Date(startsAt.getTime() + slotMinutes * 60_000);

      // Drop past slots (a slot whose start is at or before now is unbookable).
      if (startsAt.getTime() <= now) continue;

      const start = startsAt.getTime();
      const end = endsAt.getTime();
      const isBusy = busyRanges.some((r) => overlaps(start, end, r.start, r.end));
      if (isBusy) continue;

      slots.push({ startsAt, endsAt });
    }
  }

  return slots;
}
