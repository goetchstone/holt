// /app/src/lib/inventory/countSchedule.ts
//
// How often each place gets counted, and which are due (GAP-17). A store sets
// `StockLocation.countEveryDays` on the places it wants on a schedule; a place
// with none is not on one, so nothing is due until a store asks.
//
// WHAT RESETS THE CLOCK
//
// A POSTED count of everything in the place. A quick count (scope PRODUCTS) only
// looked at the products it named, and a cancelled one changed nothing. A count
// still waiting to be posted doesn't reset the clock either, but the people who
// could act on the place have nothing to do except post it, so it reads as
// "waiting" and sorts after what still needs counting.
//
// A place never counted is due now. A GROUP place holds other places and can't be
// counted (lib/inventory/count.ts refuses it), so it can't be put on a schedule,
// and one that became a group afterwards drops off the list.

import type { Prisma, PrismaClient } from "@prisma/client";
import { getBusinessTimeZone } from "@/lib/appSettings";
import { isStockLocationType, LOCATION_TYPE_INFO } from "@/lib/inventory/locationTypes";
import { addDays, businessDayKey, daysBetween } from "@/lib/reports/businessDay";

/** The range the database CHECKs too (migration 20261104140000). */
export const COUNT_EVERY_DAYS_MAX = 3650;

function canBeCounted(locationType: string): boolean {
  return !isStockLocationType(locationType) || LOCATION_TYPE_INFO[locationType].holdsStock;
}

/**
 * Why this schedule can't be saved on a place of this type, or null. Null or
 * absent clears the schedule, which is always allowed. Shared by the routes that
 * create and edit a place (rule 42).
 */
export function countEveryDaysProblem(value: unknown, locationType: string): string | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > COUNT_EVERY_DAYS_MAX
  ) {
    return `Count every: a whole number of days from 1 to ${COUNT_EVERY_DAYS_MAX}, or empty for no schedule.`;
  }
  if (!canBeCounted(locationType)) {
    return "This place groups other places, so it can't be counted. Schedule the places inside it.";
  }
  return null;
}

export type CountStanding = "OVERDUE" | "DUE" | "WAITING" | "NOT_YET";

export interface ScheduledCount {
  stockLocationId: number;
  code: string;
  place: string;
  store: string;
  everyDays: number;
  /** The store day of the last posted count of everything here; null if never. */
  lastCountedOn: string | null;
  /** The day it next falls due; null when it has never been counted. */
  dueOn: string | null;
  standing: CountStanding;
  /** Days past due; 0 unless OVERDUE. */
  daysLate: number;
}

/** Where a place stands against its schedule. Pure. */
export function countStanding(args: {
  everyDays: number;
  lastCountedOn: string | null;
  waitingToPost: boolean;
  today: string;
}): Pick<ScheduledCount, "dueOn" | "standing" | "daysLate"> {
  const dueOn = args.lastCountedOn ? addDays(args.lastCountedOn, args.everyDays) : null;
  const atOrPastDue = dueOn === null || dueOn <= args.today;
  if (atOrPastDue && args.waitingToPost) return { dueOn, standing: "WAITING", daysLate: 0 };
  if (dueOn === null) return { dueOn, standing: "DUE", daysLate: 0 };
  if (dueOn > args.today) return { dueOn, standing: "NOT_YET", daysLate: 0 };
  if (dueOn === args.today) return { dueOn, standing: "DUE", daysLate: 0 };
  return { dueOn, standing: "OVERDUE", daysLate: daysBetween(dueOn, args.today) };
}

const STANDING_ORDER: Record<CountStanding, number> = {
  OVERDUE: 0,
  DUE: 1,
  WAITING: 2,
  NOT_YET: 3,
};

/** Most in need of counting first. Never counted has no date, so it sorts before any. */
export function sortSchedule(rows: readonly ScheduledCount[]): ScheduledCount[] {
  return [...rows].sort(
    (a, b) =>
      STANDING_ORDER[a.standing] - STANDING_ORDER[b.standing] ||
      b.daysLate - a.daysLate ||
      (a.dueOn ?? "").localeCompare(b.dueOn ?? "") ||
      a.store.localeCompare(b.store) ||
      a.place.localeCompare(b.place),
  );
}

/** Every active place on a schedule, most in need of counting first. */
export async function countSchedule(
  db: PrismaClient | Prisma.TransactionClient,
): Promise<ScheduledCount[]> {
  const timeZone = await getBusinessTimeZone();
  const today = businessDayKey(new Date(), timeZone);

  const places = await db.stockLocation.findMany({
    where: { isActive: true, countEveryDays: { not: null } },
    select: {
      id: true,
      code: true,
      name: true,
      locationType: true,
      countEveryDays: true,
      storeLocation: { select: { name: true } },
    },
  });
  const countable = places.filter((p) => canBeCounted(p.locationType));
  const ids = countable.map((p) => p.id);

  const [posted, waiting] = await Promise.all([
    db.stockCount.groupBy({
      by: ["stockLocationId"],
      where: { stockLocationId: { in: ids }, status: "POSTED", scope: "PLACE" },
      _max: { countedAt: true },
    }),
    db.stockCount.findMany({
      where: { stockLocationId: { in: ids }, status: "SUBMITTED", scope: "PLACE" },
      select: { stockLocationId: true },
      distinct: ["stockLocationId"],
    }),
  ]);
  const lastCounted = new Map(posted.map((p) => [p.stockLocationId, p._max.countedAt]));
  const waitingAt = new Set(waiting.map((w) => w.stockLocationId));

  return sortSchedule(
    countable.map((p) => {
      const last = lastCounted.get(p.id) ?? null;
      const lastCountedOn = last ? businessDayKey(last, timeZone) : null;
      const everyDays = p.countEveryDays as number;
      return {
        stockLocationId: p.id,
        code: p.code,
        place: p.name,
        store: p.storeLocation.name,
        everyDays,
        lastCountedOn,
        ...countStanding({
          everyDays,
          lastCountedOn,
          waitingToPost: waitingAt.has(p.id),
          today,
        }),
      };
    }),
  );
}
