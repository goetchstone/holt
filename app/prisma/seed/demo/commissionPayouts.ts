// app/prisma/seed/demo/commissionPayouts.ts
//
// Generates real CommissionPayout rows by calling the SAME orchestrator
// the admin "lock it in" flow uses (lib/runCommissionPayouts.ts's
// commitPayoutsForPeriod) — not hand-written payout numbers. One calendar-
// month pay period per month in the seed window; every period except the
// most recent is locked (a pay period that's still open/in-flight is the
// realistic state for "this month," matching how the real flow works —
// see docs/domains/commission.md).
//
// A locked month is also PAID, the way a business that keeps up pays it: the
// month is locked a few days after it closes and paid with the payroll on the
// 15th of the next month. Until 2026-10-17 no payout carried a paid date, so
// every "Paid" cell in the demo read "—" and commission looked like money owed
// forever. A month whose payday has not come yet stays locked and unpaid, which
// is what "outstanding" means.
//
// The orchestrator only pays ACTIVE staff, because in real use it runs each
// month while everyone on it still works there. The seed runs eighteen months
// at once, after the fact -- so a designer who left would get no history at all
// for the months they sold. They are made active for the periods before they
// left, exactly as they were when those months were run, and archived again.

// Deliberately does NOT take a PrismaClient parameter: commitPayoutsForPeriod
// reaches through its own `@/lib/prisma` singleton import internally (same
// process, same DATABASE_URL), so there is nothing for a passed-in client to
// do here. See docs/domains/seed-data.md "One Prisma client, one connection
// pool" for why the rest of this seed shares that same singleton too.
import { prisma } from "@/lib/prisma";
import { commitPayoutsForPeriod, type PayoutOverride } from "@/lib/runCommissionPayouts";
import type { SeedWindow } from "./config";

const ACTOR_EMAIL = "owner@example.com";
const DAY_MS = 86_400_000;
/** Locked this many days after the month closes. */
const LOCK_AFTER_DAYS = 3;
/** Paid with the payroll on this day of the following month. */
const PAYDAY = 15;

export interface CommissionPayoutsResult {
  periodsProcessed: number;
  payoutsCreated: number;
  payoutsLocked: number;
  payoutsPaid: number;
}

function monthRanges(window: { start: Date; end: Date }): { start: Date; end: Date }[] {
  const ranges: { start: Date; end: Date }[] = [];
  const cursor = new Date(Date.UTC(window.start.getUTCFullYear(), window.start.getUTCMonth(), 1));
  while (cursor.getTime() <= window.end.getTime()) {
    const start = new Date(cursor);
    const end = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0)); // last day of month
    ranges.push({ start, end: end > window.end ? window.end : end });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return ranges;
}

export async function seedCommissionPayouts(window: SeedWindow): Promise<CommissionPayoutsResult> {
  const ranges = monthRanges(window);
  const result: CommissionPayoutsResult = {
    periodsProcessed: ranges.length,
    payoutsCreated: 0,
    payoutsLocked: 0,
    payoutsPaid: 0,
  };

  // Archived sellers, and the last day each of them sold.
  const departed = await prisma.staffMember.findMany({
    where: { isActive: false },
    select: {
      id: true,
      salesOrders: { select: { orderDate: true }, orderBy: { orderDate: "desc" }, take: 1 },
    },
  });
  const leftAfter = new Map(departed.map((d) => [d.id, d.salesOrders[0]?.orderDate ?? null]));
  const everyone = (await prisma.staffMember.findMany({ select: { id: true } })).map((s) => s.id);

  try {
    for (const [i, range] of ranges.entries()) {
      // Who worked here when this month was run: everyone current, plus anyone
      // since archived whose last sale falls in this month or later.
      const stillHere = [...leftAfter]
        .filter(([, last]) => last != null && last.getTime() >= range.start.getTime())
        .map(([id]) => id);
      await prisma.staffMember.updateMany({
        where: { id: { in: [...leftAfter.keys()] } },
        data: { isActive: false },
      });
      if (stillHere.length > 0) {
        await prisma.staffMember.updateMany({
          where: { id: { in: stillHere } },
          data: { isActive: true },
        });
      }

      const isMostRecent = i === ranges.length - 1;
      const payday = new Date(
        Date.UTC(range.end.getUTCFullYear(), range.end.getUTCMonth() + 1, PAYDAY, 16, 0),
      );
      const paidOn = !isMostRecent && payday.getTime() <= window.now.getTime() ? payday : null;
      const overrides: PayoutOverride[] = everyone.map((staffMemberId) => ({
        staffMemberId,
        paidOn,
      }));

      const committed = await commitPayoutsForPeriod(range.start, range.end, overrides, {
        lockNow: !isMostRecent,
        actorEmail: ACTOR_EMAIL,
      });
      result.payoutsCreated += committed.created + committed.updated;
      if (isMostRecent) continue;

      // Locking stamps the run's own clock. Put it back to when the month was
      // actually locked, a few days after it closed.
      await prisma.commissionPayout.updateMany({
        where: { id: { in: committed.payoutIds } },
        data: {
          lockedAt: new Date(range.end.getTime() + LOCK_AFTER_DAYS * DAY_MS + 14 * 3_600_000),
        },
      });
      result.payoutsLocked += committed.payoutIds.length;
      if (paidOn) result.payoutsPaid += committed.payoutIds.length;
    }
  } finally {
    // Whatever happened above, everyone who left is archived again.
    await prisma.staffMember.updateMany({
      where: { id: { in: [...leftAfter.keys()] } },
      data: { isActive: false },
    });
  }

  return result;
}
