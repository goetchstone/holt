// /app/__tests__/bookingAvailability.test.ts

import { computeWindowSlots } from "@/lib/booking/availability";

// Anchor at a fixed instant; build the window for that same weekday with a start
// time after `fromDate`'s time so day-0 slots are all in the future.
const FROM = new Date(2026, 5, 1, 8, 0); // 2026-06-01 08:00 local
const DOW = FROM.getDay();

describe("computeWindowSlots", () => {
  it("generates duration-stepped slots inside a window", () => {
    const slots = computeWindowSlots({
      fromDate: FROM,
      windowDays: 1,
      durationMinutes: 60,
      bufferMinutes: 0,
      windows: [{ dayOfWeek: DOW, startTime: "09:00", endTime: "12:00" }],
      busy: [],
    });
    expect(slots.map((s) => s.startsAt.getHours())).toEqual([9, 10, 11]);
    expect(slots[0].endsAt.getHours()).toBe(10);
  });

  it("adds the buffer to the step between starts", () => {
    const slots = computeWindowSlots({
      fromDate: FROM,
      windowDays: 1,
      durationMinutes: 60,
      bufferMinutes: 30, // step = 90
      windows: [{ dayOfWeek: DOW, startTime: "09:00", endTime: "12:00" }],
      busy: [],
    });
    expect(slots.map((s) => `${s.startsAt.getHours()}:${s.startsAt.getMinutes()}`)).toEqual([
      "9:0",
      "10:30",
    ]);
  });

  it("drops past slots", () => {
    const slots = computeWindowSlots({
      fromDate: new Date(2026, 5, 1, 10, 0),
      windowDays: 1,
      durationMinutes: 60,
      bufferMinutes: 0,
      windows: [{ dayOfWeek: DOW, startTime: "09:00", endTime: "12:00" }],
      busy: [],
    });
    expect(slots.map((s) => s.startsAt.getHours())).toEqual([11]);
  });

  it("excludes slots overlapping a busy interval but keeps touching edges", () => {
    const slots = computeWindowSlots({
      fromDate: FROM,
      windowDays: 1,
      durationMinutes: 60,
      bufferMinutes: 0,
      windows: [{ dayOfWeek: DOW, startTime: "09:00", endTime: "12:00" }],
      busy: [{ startsAt: new Date(2026, 5, 1, 10, 0), endsAt: new Date(2026, 5, 1, 11, 0) }],
    });
    expect(slots.map((s) => s.startsAt.getHours())).toEqual([9, 11]);
  });

  it("only matches the configured weekday", () => {
    const slots = computeWindowSlots({
      fromDate: FROM,
      windowDays: 1,
      durationMinutes: 60,
      bufferMinutes: 0,
      windows: [{ dayOfWeek: (DOW + 1) % 7, startTime: "09:00", endTime: "12:00" }],
      busy: [],
    });
    expect(slots).toEqual([]);
  });

  it("returns empty when no windows are configured", () => {
    expect(
      computeWindowSlots({
        fromDate: FROM,
        windowDays: 14,
        durationMinutes: 60,
        bufferMinutes: 0,
        windows: [],
        busy: [],
      }),
    ).toEqual([]);
  });
});
