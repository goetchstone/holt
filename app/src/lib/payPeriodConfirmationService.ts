// /app/src/lib/payPeriodConfirmationService.ts
//
// Orchestration for the pay-period confirmation ledger: confirm,
// reopen, and per-period status. Thin DB layer over the pure
// `payPeriodLock.ts` guards. See docs/domains/commission.md.

import { prisma } from "@/lib/prisma";
import { isPeriodConfirmable } from "@/lib/payPeriodLock";
import { payPeriodFromStart, type PayPeriod } from "@/lib/payPeriod";
import {
  findOpenIssue,
  summarizeOpenIssues,
  type PayPeriodIssueLike,
  type PeriodIssueSummary,
} from "@/lib/payPeriodIssue";

const ISSUE_SELECT = {
  id: true,
  staffMemberId: true,
  note: true,
  reportedBy: true,
  reportedAt: true,
  resolvedAt: true,
} as const;

export class PeriodNotEndedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "PeriodNotEndedError";
  }
}

/**
 * Confirm a designer's numbers for a period. Rejects if the period
 * hasn't ended yet (`isPeriodConfirmable`). Idempotent: a row that
 * exists but was reopened gets re-confirmed (reopen fields cleared);
 * a row already active is left as-is.
 */
export async function confirmPayPeriod(args: {
  staffMemberId: number;
  period: PayPeriod;
  confirmedBy: string;
  now?: Date;
}): Promise<{ id: number; alreadyConfirmed: boolean }> {
  const now = args.now ?? new Date();
  const gate = isPeriodConfirmable(args.period.end, now);
  if (!gate.ok) throw new PeriodNotEndedError(gate.reason);

  const existing = await prisma.payPeriodConfirmation.findUnique({
    where: {
      staffMemberId_periodStart_periodEnd: {
        staffMemberId: args.staffMemberId,
        periodStart: args.period.start,
        periodEnd: args.period.end,
      },
    },
    select: { id: true, reopenedAt: true },
  });

  if (existing?.reopenedAt === null) {
    return { id: existing.id, alreadyConfirmed: true };
  }

  if (existing) {
    // Was reopened — re-confirm clears the reopen fields.
    await prisma.payPeriodConfirmation.update({
      where: { id: existing.id },
      data: {
        confirmedAt: now,
        confirmedBy: args.confirmedBy,
        reopenedAt: null,
        reopenedBy: null,
        reopenReason: null,
        updatedBy: args.confirmedBy,
      },
    });
    return { id: existing.id, alreadyConfirmed: false };
  }

  const created = await prisma.payPeriodConfirmation.create({
    data: {
      staffMemberId: args.staffMemberId,
      periodStart: args.period.start,
      periodEnd: args.period.end,
      confirmedAt: now,
      confirmedBy: args.confirmedBy,
      createdBy: args.confirmedBy,
    },
  });
  return { id: created.id, alreadyConfirmed: false };
}

/** Reopen a confirmation (manager / SUPER_ADMIN). `reason` required. */
export async function reopenPayPeriod(args: {
  confirmationId: number;
  reopenedBy: string;
  reason: string;
  now?: Date;
}): Promise<void> {
  await prisma.payPeriodConfirmation.update({
    where: { id: args.confirmationId },
    data: {
      reopenedAt: args.now ?? new Date(),
      reopenedBy: args.reopenedBy,
      reopenReason: args.reason,
      updatedBy: args.reopenedBy,
    },
  });
}

/**
 * A designer flags that their numbers look wrong. Does NOT lock the
 * period — it raises a flag for the manager to fix the numbers before
 * anyone confirms. Idempotent: if an OPEN issue already exists for the
 * designer + period, returns it instead of stacking a duplicate.
 */
export async function reportPayPeriodIssue(args: {
  staffMemberId: number;
  period: PayPeriod;
  note: string;
  reportedBy: string;
  now?: Date;
}): Promise<{ id: number; alreadyOpen: boolean }> {
  const existing = await prisma.payPeriodIssue.findMany({
    where: {
      staffMemberId: args.staffMemberId,
      periodStart: args.period.start,
      periodEnd: args.period.end,
      resolvedAt: null,
    },
    select: ISSUE_SELECT,
  });

  const open = findOpenIssue(existing);
  if (open) return { id: open.id, alreadyOpen: true };

  const created = await prisma.payPeriodIssue.create({
    data: {
      staffMemberId: args.staffMemberId,
      periodStart: args.period.start,
      periodEnd: args.period.end,
      note: args.note,
      reportedBy: args.reportedBy,
      reportedAt: args.now ?? new Date(),
      createdBy: args.reportedBy,
    },
  });
  return { id: created.id, alreadyOpen: false };
}

/** Resolve an open issue (manager / SUPER_ADMIN). */
export async function resolvePayPeriodIssue(args: {
  issueId: number;
  resolvedBy: string;
  resolutionNote?: string;
  now?: Date;
}): Promise<void> {
  await prisma.payPeriodIssue.update({
    where: { id: args.issueId },
    data: {
      resolvedAt: args.now ?? new Date(),
      resolvedBy: args.resolvedBy,
      resolutionNote: args.resolutionNote ?? null,
      updatedBy: args.resolvedBy,
    },
  });
}

/** Open-issue summary for one designer + period (drives the statement badge). */
export async function getOpenIssueSummary(
  staffMemberId: number,
  period: PayPeriod,
): Promise<PeriodIssueSummary> {
  const issues = await prisma.payPeriodIssue.findMany({
    where: { staffMemberId, periodStart: period.start, periodEnd: period.end },
    select: ISSUE_SELECT,
  });
  return summarizeOpenIssues(issues);
}

export interface PeriodConfirmationStatusRow {
  staffMemberId: number;
  displayName: string;
  confirmationId: number | null;
  confirmedAt: Date | null;
  confirmedBy: string | null;
  reopenedAt: Date | null;
  /** Active (locking) = confirmed AND not reopened. */
  isLocked: boolean;
  /** Latest OPEN issue this designer raised for the period, or null. */
  openIssue: { id: number; note: string; reportedBy: string; reportedAt: Date } | null;
}

/**
 * Status of every active designer for a period — who's confirmed,
 * who hasn't, who's been reopened. Drives the manager grid + the
 * "ready for review" signal (all active designers locked).
 */
export async function listPeriodConfirmationStatus(
  period: PayPeriod,
): Promise<{ rows: PeriodConfirmationStatusRow[]; readyForReview: boolean }> {
  const [designers, confirmations, issues] = await Promise.all([
    prisma.staffMember.findMany({
      where: { isDesigner: true, isActive: true },
      select: { id: true, displayName: true },
      orderBy: { displayName: "asc" },
    }),
    prisma.payPeriodConfirmation.findMany({
      where: { periodStart: period.start, periodEnd: period.end },
      select: {
        id: true,
        staffMemberId: true,
        confirmedAt: true,
        confirmedBy: true,
        reopenedAt: true,
      },
    }),
    prisma.payPeriodIssue.findMany({
      where: { periodStart: period.start, periodEnd: period.end },
      select: ISSUE_SELECT,
    }),
  ]);

  const byStaff = new Map(confirmations.map((c) => [c.staffMemberId, c]));
  const issuesByStaff = new Map<number, PayPeriodIssueLike[]>();
  for (const issue of issues) {
    const list = issuesByStaff.get(issue.staffMemberId) ?? [];
    list.push(issue);
    issuesByStaff.set(issue.staffMemberId, list);
  }

  const rows: PeriodConfirmationStatusRow[] = designers.map((d) => {
    const c = byStaff.get(d.id);
    const openIssue = findOpenIssue(issuesByStaff.get(d.id) ?? []);
    return {
      staffMemberId: d.id,
      displayName: d.displayName,
      confirmationId: c?.id ?? null,
      confirmedAt: c?.confirmedAt ?? null,
      confirmedBy: c?.confirmedBy ?? null,
      reopenedAt: c?.reopenedAt ?? null,
      isLocked: c?.reopenedAt === null,
      openIssue: openIssue
        ? {
            id: openIssue.id,
            note: openIssue.note,
            reportedBy: openIssue.reportedBy,
            reportedAt: openIssue.reportedAt,
          }
        : null,
    };
  });

  // "Ready for review" means clean: every active designer confirmed AND
  // no open issues flagged. An open issue blocks the all-clear signal.
  const readyForReview =
    rows.length > 0 && rows.every((r) => r.isLocked) && rows.every((r) => r.openIssue === null);
  return { rows, readyForReview };
}

/** Parse a YYYY-MM-DD periodStart into a PayPeriod (UTC), or null. */
export function periodFromStartParam(raw: unknown): PayPeriod | null {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const d = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return payPeriodFromStart(d);
}
