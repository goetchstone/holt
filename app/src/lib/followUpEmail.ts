// /app/src/lib/followUpEmail.ts
//
// The morning email (GAP-36): each salesperson's follow-ups due, quotes waiting and past
// clients worth a call. The email-queue cron asks here on each run, so it goes in the first
// run after the store's hour (Settings > Morning email), once a store day. Each person can
// turn theirs off on My Clients. Nobody gets an empty one. Claiming the day and queuing are
// one transaction, so two runs at once send one set, and a failure tries again next run.

import { DEFAULT_ORG_ID, getAppSettings } from "@/lib/appSettings";
import { parseClientBookOptions, readOutreachRules } from "@/lib/clientBook";
import { fetchClientBook, type ClientBookRow } from "@/lib/clientBookQuery";
import { CLIENT_OWNER_ROLES } from "@/lib/clientOwnership";
import { enqueueEmail } from "@/lib/email/queue";
import { followUpEmail, type FollowUpEmailClient, type RenderedEmail } from "@/lib/email/templates";
import { formatMoney } from "@/lib/formatMoney";
import type { FollowUpRow } from "@/lib/followUpReport";
import { countQuotesWaitingByStaff, loadFollowUpRows } from "@/lib/followUpReportQuery";
import { logError } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { businessDayKey, businessHourStart, dayKeyToDbDate } from "@/lib/reports/businessDay";
import { getEmailChrome } from "@/lib/email/wordingSettings";

const SUGGESTED_LISTED = 5;
const NOTE_LENGTH = 100;

/** How many went, or why none did. */
export type FollowUpEmailResult =
  "off" | "not-yet" | "already-sent" | { queued: number; nothingToSay: number; failed: number };

interface Formats {
  money: (amount: number) => string;
  shortDate: (dayKey: string) => string;
  monthYear: (iso: string) => string;
}

function formatsFor(app: { locale: string; currency: string; timezone: string }): Formats {
  const short = new Intl.DateTimeFormat(app.locale, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  const month = new Intl.DateTimeFormat(app.locale, {
    month: "short",
    year: "numeric",
    timeZone: app.timezone,
  });
  return {
    money: (amount) =>
      formatMoney(amount, { locale: app.locale, currency: app.currency, whole: true }),
    shortDate: (dayKey) => short.format(dayKeyToDbDate(dayKey)),
    monthYear: (iso) => month.format(new Date(iso)),
  };
}

function joinDetails(parts: (string | null | undefined)[]): string {
  return parts.filter(Boolean).join(", ");
}

function dueClient(row: FollowUpRow, formats: Formats): FollowUpEmailClient {
  return {
    name: row.clientName,
    detail: joinDetails([
      `due ${formats.shortDate(row.nextFollowUpDate)}`,
      row.phone,
      row.lastNote ? `last note: ${row.lastNote.slice(0, NOTE_LENGTH)}` : null,
    ]),
  };
}

function suggestedClient(row: ClientBookRow, formats: Formats): FollowUpEmailClient {
  const lastOrder = row.history.lastPurchase?.orderDate;
  return {
    name: `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim() || "No name",
    detail: joinDetails([
      `${formats.money(row.history.lifetimeSpend)} lifetime`,
      lastOrder ? `last order ${formats.monthYear(lastOrder)}` : null,
      row.history.brands.slice(0, 2).join(" and "),
      row.phone,
    ]),
  };
}

export async function queueFollowUpEmails(now: Date = new Date()): Promise<FollowUpEmailResult> {
  const app = await getAppSettings();
  if (app.followUpEmailHour == null) return "off";
  const today = businessDayKey(now, app.timezone);
  if (now < businessHourStart(today, app.followUpEmailHour, app.timezone)) return "not-yet";
  const sentOn = await prisma.appSettings.findUnique({
    where: { organizationId: DEFAULT_ORG_ID },
    select: { followUpEmailedOn: true },
  });
  if (sentOn?.followUpEmailedOn === today) return "already-sent";

  const rules = readOutreachRules(app);
  const formats = formatsFor(app);
  const chrome = await getEmailChrome("follow-up");
  const baseUrl = (process.env.NEXTAUTH_URL || "http://localhost:3000").replace(/\/+$/, "");
  const [staffMembers, followUps, quotesWaiting] = await Promise.all([
    prisma.staffMember.findMany({
      where: {
        isActive: true,
        followUpEmailOff: false,
        role: { in: [...CLIENT_OWNER_ROLES] },
        email: { not: null },
      },
      select: { id: true, displayName: true, aliases: true, email: true },
      orderBy: { displayName: "asc" },
    }),
    loadFollowUpRows(now),
    countQuotesWaitingByStaff(now),
  ]);

  const emails: (RenderedEmail & { to: string })[] = [];
  let nothingToSay = 0;
  let failed = 0;
  // One person's trouble doesn't stop the rest.
  for (const staff of staffMembers) {
    try {
      const suggested = rules
        ? await fetchClientBook(staff, parseClientBookOptions({ followUp: "suggested" }), now)
        : { rows: [], total: 0 };
      const email = followUpEmail({
        chrome,
        storeName: app.companyName?.trim() || app.appName,
        staffName: staff.displayName,
        baseUrl,
        due: followUps
          .filter((row) => row.ownerId === staff.id && row.status === "due")
          .map((row) => dueClient(row, formats)),
        quotesWaiting: quotesWaiting.get(staff.id) ?? 0,
        suggested: suggested.rows
          .slice(0, SUGGESTED_LISTED)
          .map((row) => suggestedClient(row, formats)),
        suggestedCount: suggested.total,
        suggestedWhy: rules
          ? `Past clients who've spent ${formats.money(rules.minLifetimeSpend)} or more, with no order in ${rules.lapsedMonths} months and no contact in ${rules.quietDays} days.`
          : "",
      });
      if (email) emails.push({ ...email, to: staff.email as string });
      else nothingToSay++;
    } catch (err) {
      failed++;
      logError(`Morning email could not be built for staff ${staff.id}`, err);
    }
  }

  return prisma.$transaction(async (tx) => {
    const claimed = await tx.appSettings.updateMany({
      where: {
        organizationId: DEFAULT_ORG_ID,
        OR: [{ followUpEmailedOn: null }, { followUpEmailedOn: { not: today } }],
      },
      data: { followUpEmailedOn: today },
    });
    if (claimed.count === 0) return "already-sent" as const;
    for (const email of emails) {
      await enqueueEmail({ ...email, templateKey: "follow-up-digest", createdBy: "system" }, tx);
    }
    return { queued: emails.length, nothingToSay, failed };
  });
}
