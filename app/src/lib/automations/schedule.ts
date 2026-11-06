// /app/src/lib/automations/schedule.ts
//
// When an automation is due (GAP-37). Pure. Hours are the store's own: "every day
// at 8" means 8 on the store's clock, through a clock change as well.
//
// An automation is due when a scheduled moment has passed since it last started, or
// since it was switched on. So switching one on at 2pm doesn't run a 4am job at once,
// and a server that was down at 4am catches up when it next wakes, once.

import type { AutomationSchedule } from "./catalog";
import { addDays, businessDayKey, businessHourStart } from "@/lib/reports/businessDay";

/** Holt is woken every 5 minutes, not exactly on the minute. */
const WAKE_SLACK_MS = 30_000;
/** How long without being woken before the screen says so: three missed wake-ups. */
export const WOKEN_LATE_AFTER_MS = 15 * 60_000;

function hourOfStoreDay(now: Date, timeZone: string): number {
  const text = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hourCycle: "h23",
  }).format(now);
  return Number.parseInt(text, 10);
}

/** The day of the week of a YYYY-MM-DD, 0 being Sunday. */
function weekdayOf(day: string): number {
  return new Date(`${day}T00:00:00.000Z`).getUTCDay();
}

/** The latest scheduled moment at or before now. Null for EVERY_MINUTES, which has none. */
export function lastScheduledMoment(
  schedule: AutomationSchedule,
  now: Date,
  timeZone: string,
): Date | null {
  const today = businessDayKey(now, timeZone);
  switch (schedule.frequency) {
    case "EVERY_MINUTES":
      return null;
    case "HOURLY":
      return businessHourStart(today, hourOfStoreDay(now, timeZone), timeZone);
    case "DAILY": {
      const hour = schedule.hour ?? 0;
      const moment = businessHourStart(today, hour, timeZone);
      return moment <= now ? moment : businessHourStart(addDays(today, -1), hour, timeZone);
    }
    case "WEEKLY": {
      const hour = schedule.hour ?? 0;
      for (let back = 0; back <= 7; back += 1) {
        const day = addDays(today, -back);
        if (weekdayOf(day) !== schedule.weekday) continue;
        const moment = businessHourStart(day, hour, timeZone);
        if (moment <= now) return moment;
      }
      return null;
    }
  }
}

export function isAutomationDue(args: {
  schedule: AutomationSchedule;
  lastStartedAt: Date | null;
  activeSince: Date | null;
  now: Date;
  timeZone: string;
}): boolean {
  const { schedule, lastStartedAt, activeSince, now, timeZone } = args;
  const times = [lastStartedAt, activeSince].filter((t): t is Date => t !== null);
  const since = times.length > 0 ? new Date(Math.max(...times.map((t) => t.getTime()))) : null;
  if (schedule.frequency === "EVERY_MINUTES") {
    if (since === null) return true;
    return now.getTime() - since.getTime() >= (schedule.everyMinutes ?? 5) * 60_000 - WAKE_SLACK_MS;
  }
  const moment = lastScheduledMoment(schedule, now, timeZone);
  if (moment === null) return false;
  return since === null || since < moment;
}
