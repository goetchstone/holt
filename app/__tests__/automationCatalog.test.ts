// __tests__/automationCatalog.test.ts
//
// Every automation is something a store can configure (GAP-37, rule 65): a route under
// pages/api/automations that runs a job has to be in the catalog, or say here why it
// isn't. The next job someone adds fails this until it has an entry on the screen.

import { readdirSync } from "node:fs";
import path from "node:path";
import {
  AUTOMATION_CATALOG,
  AUTOMATION_KEYS,
  MINUTE_CHOICES,
  automationScheduleProblem,
  describeSchedule,
  hourLabel,
  isAutomationKey,
  normalizeSchedule,
} from "@/lib/automations/catalog";
import { isWokenLate } from "@/lib/automations/screen";

const ROUTES = path.join(__dirname, "..", "src", "pages", "api", "automations");

/** Routes that don't do a job on a schedule, each with its reason. */
const NOT_AN_AUTOMATION: Record<string, string> = {
  "tick.ts": "The wake-up itself: it runs the automations rather than being one.",
  "gmail-import.ts": "An old name for source-import, which is in the catalog. It only delegates.",
  "import-health.ts": "Reads how the import is doing. Changes nothing.",
  "import-history.ts": "Reads past imports. Changes nothing.",
  "mailchimp-health.ts": "Reads how the sync is doing. Changes nothing.",
  "mailchimp-history.ts": "Reads past syncs. Changes nothing.",
  "source-readiness.ts": "Reads whether the import is set up. Changes nothing.",
};

describe("every automation route", () => {
  const files = readdirSync(ROUTES).filter((f) => f.endsWith(".ts"));
  const inCatalog = new Set(
    AUTOMATION_KEYS.map((key) => AUTOMATION_CATALOG[key].route.replace("/api/automations/", "")),
  );

  it("is in the catalog, or says why it isn't", () => {
    const unexplained = files.filter(
      (f) => !inCatalog.has(f.replace(/\.ts$/, "")) && !(f in NOT_AN_AUTOMATION),
    );
    expect(unexplained).toEqual([]);
  });
  it("isn't both", () => {
    const both = files.filter(
      (f) => inCatalog.has(f.replace(/\.ts$/, "")) && f in NOT_AN_AUTOMATION,
    );
    expect(both).toEqual([]);
  });
  it("still exists, for everything the catalog and this list name", () => {
    const missing = [
      ...[...inCatalog].map((name) => `${name}.ts`),
      ...Object.keys(NOT_AN_AUTOMATION),
    ].filter((f) => !files.includes(f));
    expect(missing).toEqual([]);
  });
});

describe("the catalog", () => {
  it.each(AUTOMATION_KEYS)("%s starts with a schedule it could save", (key) => {
    const { schedule, frequencies } = AUTOMATION_CATALOG[key];
    expect(automationScheduleProblem(schedule, frequencies)).toBeNull();
  });

  it("won't run reconciliation less than daily, which only looks at yesterday", () => {
    expect(AUTOMATION_CATALOG.reconciliation.frequencies).toEqual(["DAILY"]);
  });

  it("won't hold email for more than an hour, password resets included", () => {
    expect(AUTOMATION_CATALOG["send-queue"].frequencies).toEqual(["EVERY_MINUTES", "HOURLY"]);
  });

  it("won't run the balance check less than daily, which looks back 26 hours", () => {
    expect(AUTOMATION_CATALOG["ar-drift"].frequencies).not.toContain("WEEKLY");
  });

  it("starts anything needing an outside system or changing a store's data switched off", () => {
    for (const key of [
      "lead-housekeeping",
      "source-import",
      "traffic",
      "mailchimp-sync",
      "mailchimp-customers",
    ] as const) {
      expect(AUTOMATION_CATALOG[key].startsOn).toBe(false);
    }
  });

  it("starts what keeps the books, stock and email right switched on", () => {
    for (const key of [
      "send-queue",
      "quote-holds",
      "stale-payments",
      "reconciliation",
      "ar-drift",
      "customer-levels",
    ] as const) {
      expect(AUTOMATION_CATALOG[key].startsOn).toBe(true);
    }
  });

  it("knows its own keys", () => {
    expect(isAutomationKey("send-queue")).toBe(true);
    expect(isAutomationKey("nope")).toBe(false);
    expect(isAutomationKey(undefined)).toBe(false);
  });
});

describe("a schedule a store sets", () => {
  const base = { everyMinutes: null, hour: null, weekday: null };
  it("takes each kind", () => {
    expect(automationScheduleProblem({ ...base, frequency: "HOURLY" })).toBeNull();
    expect(automationScheduleProblem({ ...base, frequency: "DAILY", hour: 0 })).toBeNull();
    expect(automationScheduleProblem({ ...base, frequency: "DAILY", hour: 23 })).toBeNull();
    expect(
      automationScheduleProblem({ ...base, frequency: "WEEKLY", hour: 4, weekday: 6 }),
    ).toBeNull();
    for (const everyMinutes of MINUTE_CHOICES) {
      expect(
        automationScheduleProblem({ ...base, frequency: "EVERY_MINUTES", everyMinutes }),
      ).toBeNull();
    }
  });
  it("refuses a frequency this automation can't do", () => {
    const weekly = { ...base, frequency: "WEEKLY" as const, hour: 4, weekday: 1 };
    expect(automationScheduleProblem(weekly, ["DAILY"])).not.toBeNull();
    expect(automationScheduleProblem(weekly, ["DAILY", "WEEKLY"])).toBeNull();
  });
  it("refuses what doesn't fit", () => {
    const refused: Parameters<typeof automationScheduleProblem>[0][] = [
      { ...base, frequency: "NEVER" as never },
      { ...base, frequency: "EVERY_MINUTES" },
      { ...base, frequency: "EVERY_MINUTES", everyMinutes: 1 },
      { ...base, frequency: "DAILY" },
      { ...base, frequency: "DAILY", hour: 24 },
      { ...base, frequency: "DAILY", hour: -1 },
      { ...base, frequency: "DAILY", hour: 1.5 },
      { ...base, frequency: "WEEKLY", hour: 4 },
      { ...base, frequency: "WEEKLY", hour: 4, weekday: 7 },
      { ...base, frequency: "WEEKLY", hour: 4, weekday: -1 },
      { ...base, frequency: "WEEKLY", weekday: 1 },
    ];
    for (const schedule of refused) expect(automationScheduleProblem(schedule)).not.toBeNull();
  });
  it("keeps only what its frequency uses", () => {
    const stale = { everyMinutes: 5, hour: 8, weekday: 2 };
    expect(normalizeSchedule({ ...stale, frequency: "HOURLY" })).toEqual({
      frequency: "HOURLY",
      everyMinutes: null,
      hour: null,
      weekday: null,
    });
    expect(normalizeSchedule({ ...stale, frequency: "DAILY" })).toEqual({
      frequency: "DAILY",
      everyMinutes: null,
      hour: 8,
      weekday: null,
    });
    expect(normalizeSchedule({ ...stale, frequency: "WEEKLY" })).toEqual({
      frequency: "WEEKLY",
      everyMinutes: null,
      hour: 8,
      weekday: 2,
    });
    expect(normalizeSchedule({ ...stale, frequency: "EVERY_MINUTES" })).toEqual({
      frequency: "EVERY_MINUTES",
      everyMinutes: 5,
      hour: null,
      weekday: null,
    });
  });
  it("reads as a person would say it", () => {
    const words = (s: Partial<Parameters<typeof describeSchedule>[0]>) =>
      describeSchedule({ ...base, frequency: "HOURLY", ...s });
    expect(words({ frequency: "EVERY_MINUTES", everyMinutes: 5 })).toBe("Every 5 minutes");
    expect(words({})).toBe("Every hour");
    expect(words({ frequency: "DAILY", hour: 0 })).toBe("Every day at 12 AM");
    expect(words({ frequency: "DAILY", hour: 12 })).toBe("Every day at 12 PM");
    expect(words({ frequency: "DAILY", hour: 22 })).toBe("Every day at 10 PM");
    expect(words({ frequency: "WEEKLY", hour: 4, weekday: 0 })).toBe("Every Sunday at 4 AM");
    expect(hourLabel(13)).toBe("1 PM");
  });
});

describe("whether anything is waking Holt", () => {
  const now = new Date("2026-11-06T12:00:00Z");
  it("says so if nothing ever has", () => {
    expect(isWokenLate(null, now)).toBe(true);
  });
  it("is fine within three wake-ups", () => {
    expect(isWokenLate(new Date("2026-11-06T11:45:00Z"), now)).toBe(false);
  });
  it("says so past that", () => {
    expect(isWokenLate(new Date("2026-11-06T11:44:59Z"), now)).toBe(true);
  });
});
