// /app/__tests__/bookingSlots.test.ts
//
// A-grade unit tests for lib/booking/slots.ts. Pure + deterministic (the caller
// passes fromDate, so no clock access). Pins: business-hours bounds, slot
// length, past-slot exclusion, busy-interval exclusion, and the half-open
// overlap rule (back-to-back bookings don't block adjacent slots).

import { generateSlots } from "@/lib/booking/slots";

// Build a local Date from y/m/d/h/min so assertions read naturally regardless
// of the test runner's timezone (the generator works in local time).
function at(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute);
}

describe("generateSlots", () => {
  it("emits fixed-length slots inside business hours", () => {
    // fromDate before business hours so day 0 is fully in the future.
    const slots = generateSlots({
      fromDate: at(2026, 7, 15, 6),
      days: 1,
      startHour: 9,
      endHour: 17,
      slotMinutes: 30,
      busy: [],
    });

    // 9:00..17:00 in 30-min slots = 16 slots/day.
    expect(slots).toHaveLength(16);
    expect(slots[0].startsAt).toEqual(at(2026, 7, 15, 9, 0));
    expect(slots[0].endsAt).toEqual(at(2026, 7, 15, 9, 30));
    // Last slot ends exactly at endHour.
    expect(slots[slots.length - 1].endsAt).toEqual(at(2026, 7, 15, 17, 0));
  });

  it("spans multiple days", () => {
    const slots = generateSlots({
      fromDate: at(2026, 7, 15, 6),
      days: 3,
      startHour: 9,
      endHour: 17,
      slotMinutes: 60,
      busy: [],
    });
    // 8 slots/day * 3 days.
    expect(slots).toHaveLength(24);
    const days = new Set(slots.map((s) => s.startsAt.getDate()));
    expect([...days].sort((a, b) => a - b)).toEqual([15, 16, 17]);
  });

  it("excludes slots in the past relative to fromDate", () => {
    // fromDate is mid-morning; slots at/before 10:30 should be dropped.
    const slots = generateSlots({
      fromDate: at(2026, 7, 15, 10, 30),
      days: 1,
      startHour: 9,
      endHour: 17,
      slotMinutes: 30,
      busy: [],
    });
    // No slot starts at or before 10:30.
    expect(slots.every((s) => s.startsAt.getTime() > at(2026, 7, 15, 10, 30).getTime())).toBe(true);
    // First available slot is 11:00.
    expect(slots[0].startsAt).toEqual(at(2026, 7, 15, 11, 0));
  });

  it("excludes slots that overlap a busy interval", () => {
    const slots = generateSlots({
      fromDate: at(2026, 7, 15, 6),
      days: 1,
      startHour: 9,
      endHour: 17,
      slotMinutes: 60,
      busy: [{ startsAt: at(2026, 7, 15, 10, 0), endsAt: at(2026, 7, 15, 11, 0) }],
    });
    // The 10:00-11:00 slot is gone; 9:00 and 11:00 remain.
    const starts = slots.map((s) => s.startsAt.getHours());
    expect(starts).not.toContain(10);
    expect(starts).toContain(9);
    expect(starts).toContain(11);
  });

  it("treats overlap as half-open: a booking ending when a slot starts does not block it", () => {
    const slots = generateSlots({
      fromDate: at(2026, 7, 15, 6),
      days: 1,
      startHour: 9,
      endHour: 17,
      slotMinutes: 60,
      // Busy 9:00-10:00 exactly. The 10:00 slot touches but does not overlap.
      busy: [{ startsAt: at(2026, 7, 15, 9, 0), endsAt: at(2026, 7, 15, 10, 0) }],
    });
    const starts = slots.map((s) => s.startsAt.getHours());
    expect(starts).not.toContain(9);
    expect(starts).toContain(10);
  });

  it("drops a slot whose interval is partially covered by a busy block", () => {
    const slots = generateSlots({
      fromDate: at(2026, 7, 15, 6),
      days: 1,
      startHour: 9,
      endHour: 12,
      slotMinutes: 60,
      // Busy 9:30-9:45 sits inside the 9:00-10:00 slot.
      busy: [{ startsAt: at(2026, 7, 15, 9, 30), endsAt: at(2026, 7, 15, 9, 45) }],
    });
    expect(slots.map((s) => s.startsAt.getHours())).not.toContain(9);
  });

  it("returns empty for non-positive days, zero slot length, or inverted hours", () => {
    const base = {
      fromDate: at(2026, 7, 15, 6),
      startHour: 9,
      endHour: 17,
      slotMinutes: 30,
      busy: [],
    };
    expect(generateSlots({ ...base, days: 0 })).toEqual([]);
    expect(generateSlots({ ...base, days: 1, slotMinutes: 0 })).toEqual([]);
    expect(generateSlots({ ...base, days: 1, startHour: 17, endHour: 9 })).toEqual([]);
  });

  it("does not emit a partial trailing slot that would run past endHour", () => {
    const slots = generateSlots({
      fromDate: at(2026, 7, 15, 6),
      days: 1,
      startHour: 9,
      endHour: 10,
      slotMinutes: 45,
      busy: [],
    });
    // Only 9:00-9:45 fits; 9:45-10:30 would exceed endHour.
    expect(slots).toHaveLength(1);
    expect(slots[0].endsAt).toEqual(at(2026, 7, 15, 9, 45));
  });
});
