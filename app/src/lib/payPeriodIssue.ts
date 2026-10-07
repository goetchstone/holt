// /app/src/lib/payPeriodIssue.ts
//
// Pure logic for the pay-period "report an issue" flag. A designer can
// flag that their numbers look wrong instead of confirming; that flag
// is OPEN until a manager resolves it. Unlike a confirmation, an open
// issue does NOT lock the period — it just signals "don't pay yet,
// fix these first" on the manager review grid.
//
// These helpers keep the open/closed branching out of the DB-layer
// service so they're unit-tested without Prisma. See
// docs/domains/commission.md.

export interface PayPeriodIssueLike {
  id: number;
  staffMemberId: number;
  note: string;
  reportedBy: string;
  reportedAt: Date;
  resolvedAt: Date | null;
}

/** An issue is open until a manager resolves it (resolvedAt set). */
export function isIssueOpen(issue: { resolvedAt: Date | null }): boolean {
  return issue.resolvedAt === null;
}

/**
 * The most recently reported OPEN issue from a set already scoped to
 * one designer + period, or null if none are open. Resolved issues
 * are ignored.
 */
export function findOpenIssue<T extends PayPeriodIssueLike>(issues: readonly T[]): T | null {
  let latest: T | null = null;
  for (const issue of issues) {
    if (!isIssueOpen(issue)) continue;
    if (latest === null || issue.reportedAt > latest.reportedAt) latest = issue;
  }
  return latest;
}

export interface PeriodIssueSummary {
  /** Count of OPEN (unresolved) issues. */
  openCount: number;
  /** Latest open issue's note, or null when nothing is open. */
  note: string | null;
  reportedBy: string | null;
  reportedAt: Date | null;
}

/**
 * Summary of OPEN issues for the manager grid + the designer's
 * "issue pending" badge. Input is scoped to one designer + period.
 */
export function summarizeOpenIssues(issues: readonly PayPeriodIssueLike[]): PeriodIssueSummary {
  const latest = findOpenIssue(issues);
  let openCount = 0;
  for (const issue of issues) if (isIssueOpen(issue)) openCount += 1;
  return {
    openCount,
    note: latest?.note ?? null,
    reportedBy: latest?.reportedBy ?? null,
    reportedAt: latest?.reportedAt ?? null,
  };
}
