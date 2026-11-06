// /app/src/lib/purchasing/lowStockAlert.ts
//
// GAP-14: the daily list of what's below its reorder point, to whoever the store
// names (Settings > Low stock alert). The email-queue cron asks here on each run
// (/api/automations/email-queue), so it goes in the first run after the store's
// hour, once a store day, and not at all when nothing is low. Claiming the day
// and queuing the emails are one transaction, so two runs at once send one list,
// and a failure tries again on the next run.

import { prisma } from "@/lib/prisma";
import { DEFAULT_ORG_ID, getAppSettings } from "@/lib/appSettings";
import { enqueueEmail } from "@/lib/email/queue";
import { lowStockEmail } from "@/lib/email/templates";
import { businessDayKey, businessHourStart } from "@/lib/reports/businessDay";
import { lowStockRows } from "./lowStock";
import { readAlertEmails } from "./lowStockShared";
import { getEmailChrome } from "@/lib/email/wordingSettings";

/** How many went, or why none did. */
export type LowStockAlertResult = "off" | "not-yet" | "already-sent" | "nothing-low" | number;

export async function queueLowStockAlert(now: Date = new Date()): Promise<LowStockAlertResult> {
  const app = await getAppSettings();
  const read = readAlertEmails(app.lowStockAlertEmails ?? "");
  if (!("emails" in read) || read.emails.length === 0 || app.lowStockAlertHour == null)
    return "off";
  const today = businessDayKey(now, app.timezone);
  if (now < businessHourStart(today, app.lowStockAlertHour, app.timezone)) return "not-yet";

  // Read before the transaction, which is one connection's worth of work.
  const chrome = await getEmailChrome("low-stock");
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.appSettings.updateMany({
      where: {
        organizationId: DEFAULT_ORG_ID,
        OR: [{ lowStockAlertedOn: null }, { lowStockAlertedOn: { not: today } }],
      },
      data: { lowStockAlertedOn: today },
    });
    if (claimed.count === 0) return "already-sent";
    const rows = await lowStockRows(tx);
    if (rows.length === 0) return "nothing-low";
    const baseUrl = (process.env.NEXTAUTH_URL || "http://localhost:3000").replace(/\/+$/, "");
    const email = lowStockEmail({
      storeName: app.companyName?.trim() || app.appName,
      rows,
      url: `${baseUrl}/app/purchasing/low-stock`,
      chrome,
    });
    for (const to of read.emails) {
      await enqueueEmail({ ...email, to, templateKey: "low-stock", createdBy: "system" }, tx);
    }
    return read.emails.length;
  });
}
