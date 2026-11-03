// /app/src/lib/messages/timing.ts
//
// When a timed customer message is due (lib/messages/catalog.ts, "timing").
// Pure.

import { addDays, businessDayKey, businessHourStart } from "@/lib/reports/businessDay";

/**
 * The day a delivery run is for, YYYY-MM-DD. Dispatch sends a run's day as
 * "YYYY-MM-DD" (dispatch/runs, pencil-in), stored as midnight UTC, so the day
 * is the instant's UTC date; the pick screen reads it the same way. Not
 * businessDayKey, which would put an Eastern store's run on the day before.
 */
export function runDay(runDate: Date): string {
  return runDate.toISOString().slice(0, 10);
}

/** The stored runDate of a run on `day`: what a filter on runDate compares with. */
export function runDateOf(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/**
 * When a delivery reminder is due: sendHour on the day offsetDays before the
 * delivery day, on the store's clock. It goes that day or not at all
 * (lib/messages/due.ts looks only for deliveries whose reminder day is today).
 */
export function reminderDueAt(
  deliveryDay: string,
  offsetDays: number,
  sendHour: number,
  timeZone: string,
): Date {
  return businessHourStart(addDays(deliveryDay, -offsetDays), sendHour, timeZone);
}

/** When a review invitation is due: sendHour on the day offsetDays after the handover's day. */
export function reviewDueAt(
  deliveredAt: Date,
  offsetDays: number,
  sendHour: number,
  timeZone: string,
): Date {
  const day = addDays(businessDayKey(deliveredAt, timeZone), offsetDays);
  return businessHourStart(day, sendHour, timeZone);
}
