// /app/src/pages/api/admin/reports/commission-payouts/index.ts
//
// SUPER_ADMIN-only. Two POST flows + one GET:
//
//   - POST ?action=preview { startDate, endDate }
//     Returns computed drafts (no DB write). Powers the "Generate
//     Payouts" review screen.
//
//   - POST ?action=commit { startDate, endDate, overrides?, lockNow }
//     Writes/updates CommissionPayout rows for the period. Already-
//     locked rows are skipped (operator must unlock first via the
//     [id] endpoint). When lockNow=true the rows ship as locked.
//
//   - GET ?staffMemberId=…&from=…&to=…&includeDrafts=
//     Lists locked + draft payouts for the report tab. Filters
//     optional.
//
// Origin: owner direction 2026-05-27.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import {
  previewPayoutsForPeriod,
  commitPayoutsForPeriod,
  findOverlappingExistingPayouts,
  OverlappingPeriodError,
  type PayoutOverride,
} from "@/lib/runCommissionPayouts";
import { listCommissionPayouts } from "@/lib/commissionPayoutList";
import { logError } from "@/lib/logger";

function parseIsoDate(value: string | undefined): Date | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

interface PreviewBody {
  startDate?: string;
  endDate?: string;
}

interface CommitBody extends PreviewBody {
  overrides?: Array<{
    staffMemberId: number;
    commissionAmount?: number;
    notes?: string | null;
    paidOn?: string | null;
  }>;
  lockNow?: boolean;
}

/** Normalize a raw paidOn input from the request body to PayoutOverride shape. */
function normalizePaidOn(raw: string | null | undefined): Date | null | undefined {
  if (raw === null) return null;
  if (raw === undefined) return undefined;
  return new Date(raw);
}

function coerceOverrides(raw: CommitBody["overrides"]): PayoutOverride[] {
  if (!raw) return [];
  return raw
    .filter(
      (
        r,
      ): r is { staffMemberId: number } & Omit<NonNullable<typeof raw>[number], "staffMemberId"> =>
        Number.isFinite(r.staffMemberId),
    )
    .map((r) => ({
      staffMemberId: r.staffMemberId,
      commissionAmount: r.commissionAmount,
      notes: r.notes ?? undefined,
      paidOn: normalizePaidOn(r.paidOn),
    }));
}

/** Validate the date range present on a preview/commit body. */
function parsePeriodRange(
  body: PreviewBody,
): { startDate: Date; endDate: Date } | { error: string } {
  const startDate = parseIsoDate(body.startDate);
  const endDate = parseIsoDate(body.endDate);
  if (!startDate || !endDate) {
    return { error: "startDate and endDate are required (YYYY-MM-DD)" };
  }
  if (endDate < startDate) {
    return { error: "endDate must be >= startDate" };
  }
  return { startDate, endDate };
}

async function handleList(req: NextApiRequest, res: NextApiResponse) {
  try {
    const staffMemberId = req.query.staffMemberId
      ? Number.parseInt(req.query.staffMemberId as string)
      : undefined;
    const payouts = await listCommissionPayouts({
      staffMemberId,
      from: parseIsoDate(req.query.from as string | undefined),
      to: parseIsoDate(req.query.to as string | undefined),
      includeDrafts: req.query.includeDrafts === "true",
    });
    return res.status(200).json({ payouts });
  } catch (err) {
    logError("commission-payouts GET failed", err);
    return res.status(500).json({ error: "Failed to load payouts" });
  }
}

function serializeOverlaps(
  rows: ReadonlyArray<Awaited<ReturnType<typeof findOverlappingExistingPayouts>>[number]>,
) {
  return rows.map((r) => ({
    payoutId: r.id,
    staffMemberId: r.staffMemberId,
    staffMemberDisplayName: r.staffMemberDisplayName,
    periodStart: r.periodStart.toISOString(),
    periodEnd: r.periodEnd.toISOString(),
    lockedAt: r.lockedAt ? r.lockedAt.toISOString() : null,
  }));
}

async function handlePreview(req: NextApiRequest, res: NextApiResponse) {
  try {
    const range = parsePeriodRange((req.body || {}) as PreviewBody);
    if ("error" in range) return res.status(400).json({ error: range.error });
    // Compute drafts AND the overlap report in parallel. The UI uses
    // `overlappingPayouts` to render a red banner + disable Save when
    // non-empty. Preview always succeeds — the block fires at commit.
    const [payouts, overlaps] = await Promise.all([
      previewPayoutsForPeriod(range.startDate, range.endDate),
      findOverlappingExistingPayouts(range.startDate, range.endDate),
    ]);
    return res.status(200).json({
      payouts,
      overlappingPayouts: serializeOverlaps(overlaps),
    });
  } catch (err) {
    logError("commission-payouts preview failed", err);
    return res.status(500).json({ error: "Failed to preview payouts" });
  }
}

async function handleCommit(req: NextApiRequest, res: NextApiResponse, actorEmail: string) {
  try {
    const body = (req.body || {}) as CommitBody;
    const range = parsePeriodRange(body);
    if ("error" in range) return res.status(400).json({ error: range.error });
    const overrides = coerceOverrides(body.overrides);
    const lockNow = body.lockNow === true;
    const result = await commitPayoutsForPeriod(range.startDate, range.endDate, overrides, {
      lockNow,
      actorEmail,
    });
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof OverlappingPeriodError) {
      // 409 Conflict + structured overlaps so the UI can show the
      // specific rows that collide (not just a wall of text).
      return res.status(409).json({
        error:
          "This pay-period range overlaps an existing draft or locked payout. " +
          "Either pick a different range or delete/unlock the conflicting row(s) first.",
        overlappingPayouts: serializeOverlaps(err.overlaps),
      });
    }
    logError("commission-payouts commit failed", err);
    return res.status(500).json({ error: "Failed to commit payouts" });
  }
}

export default requireAuthWithRole(
  ["SUPER_ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    const actorEmail = session?.user?.email || "unknown";

    if (req.method === "GET") return handleList(req, res);
    if (req.method !== "POST") {
      res.setHeader("Allow", ["GET", "POST"]);
      return res.status(405).json({ error: "Method not allowed" });
    }

    const action = (req.query.action as string) || "preview";
    if (action === "preview") return handlePreview(req, res);
    if (action === "commit") return handleCommit(req, res, actorEmail);
    return res.status(400).json({ error: `Unknown action: ${action}` });
  },
);
