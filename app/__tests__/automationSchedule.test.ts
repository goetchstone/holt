// __tests__/automationSchedule.test.ts
//
// When an automation is due (GAP-37). Times are written in UTC with the store's hour
// beside them, since "every day at 8" means 8 on the store's clock.

import { isAutomationDue, lastScheduledMoment } from "@/lib/automations/schedule";
import type { AutomationSchedule } from "@/lib/automations/catalog";

const NY = "America/New_York";

const daily = (hour: number): AutomationSchedule => ({
  frequency: "DAILY",
  everyMinutes: null,
  hour,
  weekday: null,
});
const weekly = (weekday: number, hour: number): AutomationSchedule => ({
  frequency: "WEEKLY",
  everyMinutes: null,
  hour,
  weekday,
});
const hourly: AutomationSchedule = {
  frequency: "HOURLY",
  everyMinutes: null,
  hour: null,
  weekday: null,
};
const every = (minutes: number): AutomationSchedule => ({
  frequency: "EVERY_MINUTES",
  everyMinutes: minutes,
  hour: null,
  weekday: null,
});

function due(
  schedule: AutomationSchedule,
  now: string,
  lastStartedAt: string | null,
  activeSince: string | null = "2026-01-01T00:00:00Z",
  timeZone = NY,
) {
  return isAutomationDue({
    schedule,
    now: new Date(now),
    lastStartedAt: lastStartedAt ? new Date(lastStartedAt) : null,
    activeSince: activeSince ? new Date(activeSince) : null,
    timeZone,
  });
}

describe("every day at an hour", () => {
  // 8am in New York on Nov 6 is 13:00 UTC.
  it("isn't due before the store's hour", () => {
    expect(due(daily(8), "2026-11-06T12:59:00Z", "2026-11-05T13:00:00Z")).toBe(false);
  });
  it("is due at the store's hour", () => {
    expect(due(daily(8), "2026-11-06T13:00:00Z", "2026-11-05T13:00:00Z")).toBe(true);
  });
  it("goes by the store's clock, not the server's", () => {
    // 13:00 UTC is 8am in New York but already 2pm in Berlin, and 5am in Los Angeles.
    const lastRun = "2026-11-05T22:00:00Z";
    expect(due(daily(8), "2026-11-06T13:00:00Z", lastRun, null, NY)).toBe(true);
    expect(due(daily(8), "2026-11-06T13:00:00Z", lastRun, null, "America/Los_Angeles")).toBe(false);
  });
  it("doesn't run twice in a day", () => {
    expect(due(daily(8), "2026-11-06T20:00:00Z", "2026-11-06T13:05:00Z")).toBe(false);
  });
  it("catches up once if the server was down at that hour", () => {
    expect(due(daily(8), "2026-11-06T18:00:00Z", "2026-11-05T13:00:00Z")).toBe(true);
    expect(due(daily(8), "2026-11-06T18:05:00Z", "2026-11-06T18:00:00Z")).toBe(false);
  });
  it("follows the store's clock through a clock change", () => {
    // Clocks went back on Nov 1, 2026: 8am was 12:00 UTC on Oct 31 and 13:00 UTC on Nov 1.
    expect(lastScheduledMoment(daily(8), new Date("2026-10-31T12:30:00Z"), NY)?.toISOString()).toBe(
      "2026-10-31T12:00:00.000Z",
    );
    expect(lastScheduledMoment(daily(8), new Date("2026-11-01T13:30:00Z"), NY)?.toISOString()).toBe(
      "2026-11-01T13:00:00.000Z",
    );
  });
  it("reads yesterday's hour before today's has come", () => {
    expect(lastScheduledMoment(daily(8), new Date("2026-11-06T12:00:00Z"), NY)?.toISOString()).toBe(
      "2026-11-05T13:00:00.000Z",
    );
  });
});

describe("switching one on", () => {
  it("doesn't run a 4am job at 2pm because it was just switched on", () => {
    expect(due(daily(4), "2026-11-06T19:00:00Z", null, "2026-11-06T18:59:00Z")).toBe(false);
  });
  it("runs it at the next 4am", () => {
    expect(due(daily(4), "2026-11-07T09:00:00Z", null, "2026-11-06T18:59:00Z")).toBe(true);
  });
  it("goes by whichever was later, the last run or switching it on", () => {
    expect(
      due(daily(4), "2026-11-07T08:59:00Z", "2026-11-01T09:00:00Z", "2026-11-06T18:59:00Z"),
    ).toBe(false);
    expect(
      due(daily(4), "2026-11-07T08:59:00Z", "2026-11-06T18:59:00Z", "2026-11-01T09:00:00Z"),
    ).toBe(false);
  });
  it("with neither a last run nor a switch-on date, is due", () => {
    expect(due(daily(4), "2026-11-06T19:00:00Z", null, null)).toBe(true);
    expect(due(every(5), "2026-11-06T19:00:00Z", null, null)).toBe(true);
  });
});

describe("every week", () => {
  // Nov 8, 2026 is a Sunday. 4am in New York is 09:00 UTC.
  const sunday4 = weekly(0, 4);
  it("is due on the day at the hour", () => {
    expect(due(sunday4, "2026-11-08T09:00:00Z", "2026-11-01T09:00:00Z")).toBe(true);
  });
  it("isn't due earlier that day", () => {
    expect(due(sunday4, "2026-11-08T08:59:00Z", "2026-11-01T09:00:00Z")).toBe(false);
  });
  it("isn't due the rest of the week", () => {
    expect(due(sunday4, "2026-11-12T12:00:00Z", "2026-11-08T09:00:00Z")).toBe(false);
  });
  it("goes by the store's day of the week, not UTC's", () => {
    // 11pm Saturday in New York is already Sunday in UTC.
    const lastRun = "2026-11-02T04:05:00Z";
    expect(due(weekly(0, 23), "2026-11-08T04:00:00Z", lastRun)).toBe(false);
    expect(
      lastScheduledMoment(weekly(6, 23), new Date("2026-11-08T04:30:00Z"), NY)?.toISOString(),
    ).toBe("2026-11-08T04:00:00.000Z");
  });
  it("finds last week's when this week's hasn't come", () => {
    expect(lastScheduledMoment(sunday4, new Date("2026-11-08T08:00:00Z"), NY)?.toISOString()).toBe(
      "2026-11-01T09:00:00.000Z",
    );
  });
});

describe("every hour", () => {
  it("is due once the store's hour turns over", () => {
    expect(due(hourly, "2026-11-06T14:00:00Z", "2026-11-06T13:05:00Z")).toBe(true);
    expect(due(hourly, "2026-11-06T13:55:00Z", "2026-11-06T13:05:00Z")).toBe(false);
  });
  it("turns over on the store's hour where that isn't UTC's", () => {
    // India is on the half hour: 14:30 UTC is 8pm there.
    const kolkata = "Asia/Kolkata";
    const moment = lastScheduledMoment(hourly, new Date("2026-11-06T14:40:00Z"), kolkata);
    expect(moment?.toISOString()).toBe("2026-11-06T14:30:00.000Z");
  });
});

describe("every few minutes", () => {
  it("is due when that long has passed", () => {
    expect(due(every(5), "2026-11-06T14:05:00Z", "2026-11-06T14:00:00Z")).toBe(true);
    expect(due(every(15), "2026-11-06T14:05:00Z", "2026-11-06T14:00:00Z")).toBe(false);
  });
  it("allows for being woken a little early", () => {
    expect(due(every(5), "2026-11-06T14:04:40Z", "2026-11-06T14:00:00Z")).toBe(true);
    expect(due(every(5), "2026-11-06T14:04:00Z", "2026-11-06T14:00:00Z")).toBe(false);
  });
  it("has no scheduled moment of its own", () => {
    expect(lastScheduledMoment(every(5), new Date(), NY)).toBeNull();
  });
});
