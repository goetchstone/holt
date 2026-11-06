// /app/src/lib/automations/catalog.ts
//
// GAP-37: the things Holt does by itself, as the code knows them. The key decides
// what runs. The store's row (AutomationSetting, Admin › Automations) decides
// whether it runs and when (owner, 2026-11-06: "Any automation should be something
// the user can configure"). Config selects behaviour, it never supplies it (rule 62).
//
// What a job starts as: on if skipping it would quietly hurt the books, stock or
// email. Off if it changes data a store may want left alone, or needs an outside
// system set up first.
//
// Pure: the screen and the server share it (rules 7, 37). Every route under
// pages/api/automations is in this list or is excused in
// __tests__/automationCatalog.test.ts, which fails on a new one (rule 65).

export const AUTOMATION_KEYS = [
  "send-queue",
  "quote-holds",
  "stale-payments",
  "reconciliation",
  "ar-drift",
  "customer-levels",
  "lead-housekeeping",
  "source-import",
  "traffic",
  "mailchimp-sync",
  "mailchimp-customers",
] as const;
export type AutomationKey = (typeof AUTOMATION_KEYS)[number];

export function isAutomationKey(value: unknown): value is AutomationKey {
  return typeof value === "string" && (AUTOMATION_KEYS as readonly string[]).includes(value);
}

export const AUTOMATION_FREQUENCIES = ["EVERY_MINUTES", "HOURLY", "DAILY", "WEEKLY"] as const;
export type AutomationFrequency = (typeof AUTOMATION_FREQUENCIES)[number];

/** Holt is woken every 5 minutes (scripts/auto-automations.sh), so no finer than that. */
export const MINUTE_CHOICES = [5, 10, 15, 30] as const;

export interface AutomationSchedule {
  frequency: AutomationFrequency;
  /** EVERY_MINUTES only: one of MINUTE_CHOICES. */
  everyMinutes: number | null;
  /** DAILY and WEEKLY: the hour of the store's day, 0-23. */
  hour: number | null;
  /** WEEKLY only: 0 is Sunday. */
  weekday: number | null;
}

export interface AutomationInfo {
  name: string;
  does: string;
  whenOff: string;
  startsOn: boolean;
  schedule: AutomationSchedule;
  /**
   * How often it can run and still do its job. Reconciliation only looks at yesterday, so
   * weekly would leave six days unchecked. Emails wait for the queue, so daily would hold a
   * password reset until tomorrow.
   */
  frequencies: readonly AutomationFrequency[];
  /** The route that runs it by hand, under pages/api. */
  route: string;
  /** Its own page with its history, where it has one. */
  detailsHref?: string;
}

const every = (minutes: number): AutomationSchedule => ({
  frequency: "EVERY_MINUTES",
  everyMinutes: minutes,
  hour: null,
  weekday: null,
});
const hourly: AutomationSchedule = {
  frequency: "HOURLY",
  everyMinutes: null,
  hour: null,
  weekday: null,
};
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

export const AUTOMATION_CATALOG: Record<AutomationKey, AutomationInfo> = {
  "send-queue": {
    name: "Send waiting emails and texts",
    does: "Sends what's waiting, and queues the customer messages, low stock list and morning emails that are due.",
    whenOff: "No email or text goes at all, including invoices and password resets.",
    startsOn: true,
    schedule: every(5),
    frequencies: ["EVERY_MINUTES", "HOURLY"],
    route: "/api/automations/email-queue",
  },
  "quote-holds": {
    name: "Release expired quote holds",
    does: "Frees stock held on a quote once its hold date has passed.",
    whenOff: "A quote nobody touches keeps its stock until someone edits it.",
    startsOn: true,
    schedule: hourly,
    frequencies: ["HOURLY", "DAILY"],
    route: "/api/automations/expire-quote-holds",
  },
  "stale-payments": {
    name: "Clear abandoned card checkouts",
    does: "Closes online payments nobody finished, so they stop reading as pending.",
    whenOff: "Abandoned checkouts stay pending and can block a new payment link.",
    startsOn: true,
    schedule: hourly,
    frequencies: ["HOURLY", "DAILY"],
    route: "/api/automations/expire-stale-pending-payments",
  },
  reconciliation: {
    name: "Daily reconciliation",
    does: "Checks the last closed day's journal against its sales, tax, cost and cash.",
    whenOff: "A mismatch between the books and the sales goes unnoticed.",
    startsOn: true,
    schedule: daily(22),
    frequencies: ["DAILY"],
    route: "/api/automations/daily-reconciliation",
    detailsHref: "/app/admin/automations/daily-reconciliation",
  },
  "ar-drift": {
    name: "Customer balance check",
    does: "Compares each recently active customer's stored balance with what their records add up to.",
    whenOff: "A wrong customer balance goes unnoticed until someone reads it.",
    startsOn: true,
    schedule: daily(4),
    frequencies: ["HOURLY", "DAILY"],
    route: "/api/automations/customer-ar-drift-check",
    detailsHref: "/app/admin/automations/customer-ar-drift-check",
  },
  "customer-levels": {
    name: "Customer levels and lifetime spend",
    does: "Recalculates each customer's lifetime spend and level.",
    whenOff: "Levels go out of date, and the suggested clients list goes empty.",
    startsOn: true,
    schedule: weekly(0, 4),
    frequencies: ["DAILY", "WEEKLY"],
    route: "/api/automations/customer-level-recalc",
  },
  "lead-housekeeping": {
    name: "Archive stale leads",
    does: "Archives leads nobody has worked in a long time.",
    whenOff: "Old leads stay on the list until someone archives them.",
    startsOn: false,
    schedule: daily(5),
    frequencies: ["DAILY", "WEEKLY"],
    route: "/api/automations/lead-housekeeping",
  },
  "source-import": {
    name: "Daily POS import",
    does: "Imports the reports your previous system sends each day.",
    whenOff: "Nothing comes in from that system by itself.",
    startsOn: false,
    schedule: daily(6),
    frequencies: ["HOURLY", "DAILY"],
    route: "/api/automations/source-import",
    detailsHref: "/app/admin/automations/pos-import",
  },
  traffic: {
    name: "Door counter traffic",
    does: "Pulls the door counter's numbers, and fills in any recent day that's missing.",
    whenOff: "Traffic reports stop at the last day pulled.",
    startsOn: false,
    schedule: daily(2),
    frequencies: ["DAILY", "WEEKLY"],
    route: "/api/automations/axper-traffic-sync",
    detailsHref: "/app/admin/automations/axper-traffic",
  },
  "mailchimp-sync": {
    name: "Mailchimp campaign results",
    does: "Pulls campaigns, their results and who clicked, and turns clicks into leads.",
    whenOff: "Campaign results and leads from them stop updating.",
    startsOn: false,
    schedule: daily(5),
    frequencies: ["HOURLY", "DAILY", "WEEKLY"],
    route: "/api/automations/mailchimp-sync",
    detailsHref: "/app/admin/automations/mailchimp-sync",
  },
  "mailchimp-customers": {
    name: "Add new customers to Mailchimp",
    does: "Adds new customers with an email address to your Mailchimp audience.",
    whenOff: "New customers aren't added to your audience.",
    startsOn: false,
    schedule: daily(6),
    frequencies: ["HOURLY", "DAILY", "WEEKLY"],
    route: "/api/automations/mailchimp-customer-sync",
  },
};

/** Why this schedule can't be saved for this automation, or null. */
export function automationScheduleProblem(
  input: AutomationSchedule,
  allowed: readonly AutomationFrequency[] = AUTOMATION_FREQUENCIES,
): string | null {
  if (!allowed.includes(input.frequency)) {
    return "How often: choose one of the choices.";
  }
  if (input.frequency === "EVERY_MINUTES") {
    if (!(MINUTE_CHOICES as readonly (number | null)[]).includes(input.everyMinutes)) {
      return `Every how many minutes: ${MINUTE_CHOICES.join(", ")}.`;
    }
  }
  if (input.frequency === "DAILY" || input.frequency === "WEEKLY") {
    const { hour } = input;
    if (hour === null || !Number.isInteger(hour) || hour < 0 || hour > 23) {
      return "At what hour: 0 to 23.";
    }
  }
  if (input.frequency === "WEEKLY") {
    const { weekday } = input;
    if (weekday === null || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      return "On which day of the week: choose one.";
    }
  }
  return null;
}

/** Keeps only what this frequency uses, so a stale hour can't linger on an hourly job. */
export function normalizeSchedule(input: AutomationSchedule): AutomationSchedule {
  return {
    frequency: input.frequency,
    everyMinutes: input.frequency === "EVERY_MINUTES" ? input.everyMinutes : null,
    hour: input.frequency === "DAILY" || input.frequency === "WEEKLY" ? input.hour : null,
    weekday: input.frequency === "WEEKLY" ? input.weekday : null,
  };
}

export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export function hourLabel(hour: number): string {
  const suffix = hour < 12 ? "AM" : "PM";
  return `${hour % 12 === 0 ? 12 : hour % 12} ${suffix}`;
}

export function describeSchedule(s: AutomationSchedule): string {
  switch (s.frequency) {
    case "EVERY_MINUTES":
      return `Every ${s.everyMinutes} minutes`;
    case "HOURLY":
      return "Every hour";
    case "DAILY":
      return `Every day at ${hourLabel(s.hour ?? 0)}`;
    case "WEEKLY":
      return `Every ${WEEKDAY_NAMES[s.weekday ?? 0]} at ${hourLabel(s.hour ?? 0)}`;
  }
}
