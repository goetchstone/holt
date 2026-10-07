// app/prisma/seed/demo/commissionPayouts.ts
//
// Generates real CommissionPayout rows by calling the SAME orchestrator
// the admin "lock it in" flow uses (lib/runCommissionPayouts.ts's
// commitPayoutsForPeriod) — not hand-written payout numbers. One calendar-
// month pay period per month in the seed window; every period except the
// most recent is locked (a pay period that's still open/in-flight is the
// realistic state for "this month," matching how the real flow works —
// see docs/domains/commission.md).

// Deliberately does NOT take a PrismaClient parameter: commitPayoutsForPeriod
// reaches through its own `@/lib/prisma` singleton import internally (same
// process, same DATABASE_URL), so there is nothing for a passed-in client to
// do here. See docs/domains/seed-data.md "One Prisma client, one connection
// pool" for why the rest of this seed shares that same singleton too.
import { commitPayoutsForPeriod } from "@/lib/runCommissionPayouts";

const ACTOR_EMAIL = "owner@example.com";

export interface CommissionPayoutsResult {
  periodsProcessed: number;
  payoutsCreated: number;
  payoutsLocked: number;
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

export async function seedCommissionPayouts(window: {
  start: Date;
  end: Date;
}): Promise<CommissionPayoutsResult> {
  const ranges = monthRanges(window);
  let payoutsCreated = 0;
  let payoutsLocked = 0;

  for (const [i, range] of ranges.entries()) {
    const isMostRecent = i === ranges.length - 1;
    const result = await commitPayoutsForPeriod(range.start, range.end, [], {
      lockNow: !isMostRecent,
      actorEmail: ACTOR_EMAIL,
    });
    payoutsCreated += result.created + result.updated;
    if (!isMostRecent) payoutsLocked += result.payoutIds.length;
  }

  return { periodsProcessed: ranges.length, payoutsCreated, payoutsLocked };
}
