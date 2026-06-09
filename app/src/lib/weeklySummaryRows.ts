// /app/src/lib/weeklySummaryRows.ts
//
// Pure row-building for the Weekly Summary report. Takes the grouped
// sales (this week + last year), goals, and foot traffic and produces
// the sorted rows the API returns. No I/O — unit-tested in isolation
// so the YoY math, the union behavior, and the company-only traffic
// attach are all covered without a DB.

export interface WeeklyRow {
  entityName: string;
  actual: number;
  goal: number;
  variance: number;
  lastYear?: number;
  yoyVariance?: number;
  yoyPercent?: number | null;
  visitors?: number;
  visitorsLastYear?: number;
  /** Sales transactions ÷ visitors × 100 (company pivot only). */
  conversionPct?: number | null;
  conversionPctLastYear?: number | null;
}

export interface BuildRowsArgs {
  entityNames: Set<string>;
  thisWeek: Map<string, number>;
  lastYear: Map<string, number>;
  annualGoals: Map<string, unknown>;
  monthPercent: number;
  daysInMonth: number;
  reportDays: number;
  wow: boolean;
  typeParam: string;
  trafficThis: Record<string, number>;
  trafficLast: Record<string, number>;
  /** Sales-transaction counts per store (company pivot). */
  transThis: Record<string, number>;
  transLast: Record<string, number>;
}

/** Conversion rate as a percent: transactions ÷ visitors × 100, or null. */
function conversion(transactions: number, visitors: number): number | null {
  return visitors > 0 ? (transactions / visitors) * 100 : null;
}

/** Build the sorted report rows, attaching YoY + traffic when in wow mode. */
export function buildRows(args: BuildRowsArgs): WeeklyRow[] {
  const { entityNames, thisWeek, lastYear, annualGoals, wow, typeParam } = args;
  return Array.from(entityNames)
    .map((entityName) => {
      const actual = thisWeek.get(entityName) ?? 0;
      const annualGoal = Number(annualGoals.get(entityName) ?? 0);
      const proratedGoal = ((annualGoal * args.monthPercent) / args.daysInMonth) * args.reportDays;
      const row: WeeklyRow = {
        entityName,
        actual,
        goal: proratedGoal,
        variance: actual - proratedGoal,
      };
      if (wow) {
        const ly = lastYear.get(entityName) ?? 0;
        row.lastYear = ly;
        row.yoyVariance = actual - ly;
        row.yoyPercent = ly === 0 ? null : ((actual - ly) / ly) * 100;
        if (typeParam === "company") {
          const visitors = args.trafficThis[entityName] ?? 0;
          const visitorsLY = args.trafficLast[entityName] ?? 0;
          row.visitors = visitors;
          row.visitorsLastYear = visitorsLY;
          row.conversionPct = conversion(args.transThis[entityName] ?? 0, visitors);
          row.conversionPctLastYear = conversion(args.transLast[entityName] ?? 0, visitorsLY);
        }
      }
      return row;
    })
    .sort((a, b) => b.actual - a.actual);
}
