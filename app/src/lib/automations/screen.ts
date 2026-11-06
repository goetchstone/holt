// /app/src/lib/automations/screen.ts
//
// What Admin > Automations shows (GAP-37): each automation, whether it can run yet,
// whether anything is waking Holt, and the messages that have their own settings
// elsewhere. Those stay where they are (rule 6): this lists them and links to them.

import { prisma } from "@/lib/prisma";
import { getAppSettings } from "@/lib/appSettings";
import { logError } from "@/lib/logger";
import { getMessageSettings } from "@/lib/messages/settings";
import { hourLabel, type AutomationKey } from "./catalog";
import { AUTOMATION_JOBS } from "./jobs";
import { WOKEN_LATE_AFTER_MS } from "./schedule";
import { getAutomationSettings, type AutomationRow } from "./settings";

export interface AutomationSentMessage {
  name: string;
  state: string;
  href: string;
}

export interface AutomationsScreen {
  rows: AutomationRow[];
  notReady: Partial<Record<AutomationKey, string>>;
  /** Null when nothing has ever woken Holt. */
  wokenAt: Date | null;
  wokenLate: boolean;
  messages: AutomationSentMessage[];
  timeZone: string;
  locale: string;
}

export function isWokenLate(wokenAt: Date | null, now: Date): boolean {
  return wokenAt === null || now.getTime() - wokenAt.getTime() > WOKEN_LATE_AFTER_MS;
}

async function readiness(key: AutomationKey): Promise<[AutomationKey, string | null]> {
  try {
    const check = AUTOMATION_JOBS[key].notReady;
    return [key, check ? await check() : null];
  } catch (err) {
    logError(`Couldn't tell whether automation ${key} is ready`, err);
    return [key, "Holt couldn't tell whether this is set up."];
  }
}

export async function loadAutomationsScreen(now: Date = new Date()): Promise<AutomationsScreen> {
  const [rows, app, woken, customerMessages] = await Promise.all([
    getAutomationSettings(),
    getAppSettings(),
    prisma.appSettings.findFirst({ select: { automationsWokenAt: true } }),
    getMessageSettings(prisma),
  ]);
  const checks = await Promise.all(rows.map((row) => readiness(row.key)));
  const notReady: AutomationsScreen["notReady"] = {};
  for (const [key, reason] of checks) if (reason) notReady[key] = reason;

  const on = customerMessages.filter((m) => m.isActive).length;
  const wokenAt = woken?.automationsWokenAt ?? null;
  return {
    rows,
    notReady,
    wokenAt,
    wokenLate: isWokenLate(wokenAt, now),
    timeZone: app.timezone,
    locale: app.locale,
    messages: [
      {
        name: "Morning follow-up email",
        state:
          app.followUpEmailHour === null
            ? "Off"
            : `Every morning at ${hourLabel(app.followUpEmailHour)}`,
        href: "/app/admin/settings#follow-ups",
      },
      {
        name: "Low stock list",
        state:
          app.lowStockAlertHour === null || !app.lowStockAlertEmails
            ? "Off"
            : `Every day at ${hourLabel(app.lowStockAlertHour)}`,
        href: "/app/admin/settings#low-stock-alert",
      },
      {
        name: "Customer messages",
        state: `${on} of ${customerMessages.length} on`,
        href: "/app/admin/setup/customer-messages",
      },
      {
        name: "Email look and wording",
        state: "All of them",
        href: "/app/admin/setup/email-look",
      },
    ],
  };
}
