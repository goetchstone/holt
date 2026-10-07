// /app/__tests__/bookingConfig.test.ts
//
// A-grade unit tests for lib/booking/config.ts. Pure, no I/O. Pins the lenient
// contract: defaults on null/garbage, missing fields filled, out-of-range values
// clamped, endHour<=startHour rejected (falls back to default hours), partial
// configs keep their provided values, and valid input passes through unchanged.

import { parseBookingConfig, BOOKING_DEFAULTS } from "@/lib/booking/config";

describe("parseBookingConfig", () => {
  it("returns defaults for null", () => {
    expect(parseBookingConfig(null)).toEqual(BOOKING_DEFAULTS);
  });

  it("returns defaults for undefined", () => {
    expect(parseBookingConfig(undefined)).toEqual(BOOKING_DEFAULTS);
  });

  it("returns defaults for garbage (string, number, array)", () => {
    expect(parseBookingConfig("nope")).toEqual(BOOKING_DEFAULTS);
    expect(parseBookingConfig(42)).toEqual(BOOKING_DEFAULTS);
    expect(parseBookingConfig([1, 2, 3])).toEqual(BOOKING_DEFAULTS);
  });

  it("fills missing fields with defaults", () => {
    expect(parseBookingConfig({})).toEqual(BOOKING_DEFAULTS);
  });

  it("keeps provided fields and defaults the rest (partial config)", () => {
    const cfg = parseBookingConfig({ windowDays: 30 });
    expect(cfg.windowDays).toBe(30);
    expect(cfg.startHour).toBe(BOOKING_DEFAULTS.startHour);
    expect(cfg.endHour).toBe(BOOKING_DEFAULTS.endHour);
    expect(cfg.slotMinutes).toBe(BOOKING_DEFAULTS.slotMinutes);
  });

  it("passes a fully valid config through unchanged", () => {
    const input = { windowDays: 7, startHour: 8, endHour: 20, slotMinutes: 60 };
    expect(parseBookingConfig(input)).toEqual(input);
  });

  it("clamps windowDays to 1-90", () => {
    expect(parseBookingConfig({ windowDays: 0 }).windowDays).toBe(1);
    expect(parseBookingConfig({ windowDays: -5 }).windowDays).toBe(1);
    expect(parseBookingConfig({ windowDays: 1000 }).windowDays).toBe(90);
  });

  it("clamps slotMinutes to 5-240", () => {
    expect(parseBookingConfig({ slotMinutes: 1 }).slotMinutes).toBe(5);
    expect(parseBookingConfig({ slotMinutes: 9999 }).slotMinutes).toBe(240);
  });

  it("clamps hours into range while keeping a valid window", () => {
    // startHour clamps to 0..23, endHour to 1..24; 25 -> 24 here keeps end > start.
    const cfg = parseBookingConfig({ startHour: -3, endHour: 25 });
    expect(cfg.startHour).toBe(0);
    expect(cfg.endHour).toBe(24);
  });

  it("rounds non-integer numeric values", () => {
    const cfg = parseBookingConfig({
      windowDays: 14.7,
      startHour: 8.4,
      endHour: 17.6,
      slotMinutes: 30.2,
    });
    expect(cfg.windowDays).toBe(15);
    expect(cfg.startHour).toBe(8);
    expect(cfg.endHour).toBe(18);
    expect(cfg.slotMinutes).toBe(30);
  });

  it("falls back to default hours when endHour <= startHour", () => {
    const equal = parseBookingConfig({ startHour: 12, endHour: 12, windowDays: 7 });
    expect(equal.startHour).toBe(BOOKING_DEFAULTS.startHour);
    expect(equal.endHour).toBe(BOOKING_DEFAULTS.endHour);
    // a non-hour field provided alongside is still respected
    expect(equal.windowDays).toBe(7);

    const inverted = parseBookingConfig({ startHour: 18, endHour: 9 });
    expect(inverted.startHour).toBe(BOOKING_DEFAULTS.startHour);
    expect(inverted.endHour).toBe(BOOKING_DEFAULTS.endHour);
  });

  it("treats non-numeric field values as missing (uses defaults)", () => {
    const cfg = parseBookingConfig({
      windowDays: "14",
      startHour: null,
      endHour: NaN,
      slotMinutes: {},
    });
    expect(cfg).toEqual(BOOKING_DEFAULTS);
  });
});
