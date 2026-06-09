// /app/src/lib/booking/config.ts
//
// Pure parser for the per-deployment booking-availability configuration stored
// in AppSettings.bookingConfig (Json). LENIENT by design: stored config is
// admin-supplied and may be partial, stale, or missing, so this never throws --
// missing fields fall back to BOOKING_DEFAULTS and out-of-range values are
// clamped to sane bounds. The resolver and the availability endpoint both rely
// on always getting back a usable BookingConfig.

import { z } from "zod";

export const BOOKING_DEFAULTS = {
  windowDays: 14,
  startHour: 9,
  endHour: 17,
  slotMinutes: 30,
} as const;

export interface BookingConfig {
  windowDays: number;
  startHour: number;
  endHour: number;
  slotMinutes: number;
}

// Bounds keep an admin typo (negative window, 25-hour day, 1-minute slots) from
// producing an empty or nonsensical schedule. endHour > startHour is enforced
// after clamping; if it still fails, both hours fall back to the defaults.
const WINDOW_DAYS = { min: 1, max: 90 } as const;
const HOUR = { min: 0, max: 24 } as const;
const SLOT_MINUTES = { min: 5, max: 240 } as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// Coerce one field: non-finite or absent -> default; otherwise round + clamp.
function clampField(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return clamp(Math.round(value), min, max);
}

// Accept any record; individual fields are read leniently below. A bare record
// schema (rather than per-field validation) keeps partial configs intact -- a
// stored `{ windowDays: 30 }` must keep its 30, not revert every field to a
// default. Non-objects (null, strings, arrays) fail and fall back to `{}`.
const rawSchema = z.record(z.string(), z.unknown());

export function parseBookingConfig(value: unknown): BookingConfig {
  const parsed = rawSchema.safeParse(value);
  const raw: Record<string, unknown> = parsed.success ? parsed.data : {};

  const windowDays = clampField(
    raw.windowDays,
    BOOKING_DEFAULTS.windowDays,
    WINDOW_DAYS.min,
    WINDOW_DAYS.max,
  );
  const slotMinutes = clampField(
    raw.slotMinutes,
    BOOKING_DEFAULTS.slotMinutes,
    SLOT_MINUTES.min,
    SLOT_MINUTES.max,
  );
  const startHour = clampField(raw.startHour, BOOKING_DEFAULTS.startHour, HOUR.min, 23);
  const endHour = clampField(raw.endHour, BOOKING_DEFAULTS.endHour, 1, HOUR.max);

  // A window where the day ends at or before it starts produces zero slots; fall
  // back to the defaults for both hours so availability stays usable.
  if (endHour <= startHour) {
    return {
      windowDays,
      startHour: BOOKING_DEFAULTS.startHour,
      endHour: BOOKING_DEFAULTS.endHour,
      slotMinutes,
    };
  }

  return { windowDays, startHour, endHour, slotMinutes };
}
