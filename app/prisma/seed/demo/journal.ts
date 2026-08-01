// app/prisma/seed/demo/journal.ts
//
// Generates real JournalEntry rows by calling the PRODUCTION
// `generateSalesJournal()` (lib/journalEntry.ts) for a handful of days
// spread across the seed window — never hand-written journal rows. This
// is the proof the whole native chain (chart of accounts -> SystemGLMapping
// -> Payment -> OrderLineItem -> AccountGroup) actually works: if any
// mapping were missing, generateSalesJournal would either throw (0 payments
// mapped, nothing to balance) or silently push a warning and lean on the
// Over/Short line — exactly the failure mode this seed exists to avoid.
//
// `generateSalesJournal(date, ...)` computes its day window via
// `date.setHours(0,0,0,0)` / `setHours(23,59,59,999)` -- LOCAL time, not
// UTC. Every payment timestamp in this seed is constructed with
// `Date.UTC(...)`, so this module (and the whole seed CLI) MUST run with
// `TZ=UTC` or the local-time day window can clip payments near midnight
// into the wrong journal. `index.ts` sets `process.env.TZ = "UTC"` before
// anything else runs, and the npm script also sets it at the process-env
// level (belt and suspenders — see docs/domains/seed-data.md "Timezone").

import type { PrismaClient } from "@prisma/client";
import { generateSalesJournal } from "@/lib/journalEntry";

const SEED_ACTOR = "seed:demo";

export interface JournalResult {
  daysProcessed: string[];
  totalDebits: number;
  totalCredits: number;
  warnings: string[];
  entries: { journalNumber: string; date: string; totalDebits: number; totalCredits: number }[];
}

/** Distinct calendar days (UTC) that have at least one Payment, evenly
 * sampled across the range plus a day that's guaranteed to include a
 * refund — so the journal run exercises both the plain-sale path and the
 * B3 sale-in-reverse refund path. */
async function pickRepresentativeDays(prisma: PrismaClient, sampleCount: number): Promise<Date[]> {
  const allDays = await prisma.$queryRawUnsafe<{ day: Date }[]>(
    `SELECT DISTINCT DATE("paymentDate") AS day FROM "Payment" ORDER BY day ASC`,
  );
  if (allDays.length === 0) return [];

  const refundDayRows = await prisma.$queryRawUnsafe<{ day: Date }[]>(
    `SELECT DISTINCT DATE("paymentDate") AS day FROM "Payment" WHERE "isRefund" = true ORDER BY day ASC LIMIT 1`,
  );

  const picks = new Set<string>();
  const days = allDays.map((r) => r.day);
  for (let i = 0; i < sampleCount; i++) {
    const idx = Math.min(days.length - 1, Math.round((i / (sampleCount - 1)) * (days.length - 1)));
    picks.add(days[idx].toISOString().slice(0, 10));
  }
  if (refundDayRows[0]) picks.add(refundDayRows[0].day.toISOString().slice(0, 10));

  return [...picks].sort().map((d) => new Date(`${d}T00:00:00.000Z`));
}

export async function seedJournalEntries(
  prisma: PrismaClient,
  sampleDayCount = 5,
): Promise<JournalResult> {
  const days = await pickRepresentativeDays(prisma, sampleDayCount);
  const result: JournalResult = {
    daysProcessed: [],
    totalDebits: 0,
    totalCredits: 0,
    warnings: [],
    entries: [],
  };

  for (const day of days) {
    const { journalEntry, warnings } = await generateSalesJournal(day, SEED_ACTOR);
    result.daysProcessed.push(day.toISOString().slice(0, 10));
    result.totalDebits += journalEntry.totalDebits;
    result.totalCredits += journalEntry.totalCredits;
    result.warnings.push(...warnings.map((w) => `${journalEntry.journalNumber}: ${w}`));
    result.entries.push({
      journalNumber: journalEntry.journalNumber,
      date: day.toISOString().slice(0, 10),
      totalDebits: journalEntry.totalDebits,
      totalCredits: journalEntry.totalCredits,
    });
  }

  return result;
}
