// /app/__tests__/bookingLoadSlots.test.ts

import { slotsIncludeStart } from "@/lib/booking/loadSlots";
import type { Slot } from "@/lib/booking/slots";

function slot(y: number, mo: number, d: number, h: number, min = 0): Slot {
  const startsAt = new Date(y, mo, d, h, min);
  return { startsAt, endsAt: new Date(startsAt.getTime() + 60 * 60_000) };
}

describe("slotsIncludeStart", () => {
  const slots: Slot[] = [slot(2026, 5, 1, 9), slot(2026, 5, 1, 10), slot(2026, 5, 1, 11)];

  it("accepts a start that exactly matches an offered slot", () => {
    expect(slotsIncludeStart(new Date(2026, 5, 1, 10), slots)).toBe(true);
  });

  it("rejects a start that is not among the offered slots (off-hours)", () => {
    // 3am is never generated inside business hours.
    expect(slotsIncludeStart(new Date(2026, 5, 1, 3), slots)).toBe(false);
  });

  it("rejects a start on the right day/hour but off the minute grid", () => {
    expect(slotsIncludeStart(new Date(2026, 5, 1, 10, 30), slots)).toBe(false);
  });

  it("rejects any start when no slots are offered (e.g. all in the past)", () => {
    expect(slotsIncludeStart(new Date(2026, 5, 1, 10), [])).toBe(false);
  });

  it("matches to the millisecond, not just the hour", () => {
    const oneMsLate = new Date(new Date(2026, 5, 1, 9).getTime() + 1);
    expect(slotsIncludeStart(oneMsLate, slots)).toBe(false);
  });
});
