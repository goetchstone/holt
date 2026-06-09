// /app/src/lib/salesPersonFkBackfill.ts
//
// Post-import sweep that fills `SalesOrder.salesPersonId` on rows
// where the FK is NULL but the `salesperson` string unambiguously
// matches a StaffMember (by displayName or any alias).
//
// CLAUDE.md gotcha: "SalesOrder.salesPersonId is NULL on most
// imported orders because the sales import only populates
// the `salesperson` STRING." This helper closes the gap going-
// forward — every successful runSalesImport call ends with this
// sweep, so new orders get FK-linked at ingest.
//
// The historical 1,814-order backfill is in
// `prisma/migrations/20260519d_backfill_salesperson_fk/migration.sql`
// (same SQL shape). This module exists so the same logic can run
// idempotently from application code each import cycle.
//
// Safe / idempotent: only updates rows where salesPersonId IS NULL,
// and only when the match is unambiguous (= exactly one StaffMember
// resolves the salesperson string). Re-running on already-backfilled
// data is a no-op.
//
// Origin: Issue #274 follow-up, ROADMAP Short-Term #12 wrap (2026-05-19).

import type { PrismaClient } from "@prisma/client";

export interface BackfillResult {
  updated: number;
}

/**
 * Sets SalesOrder.salesPersonId for all NULL-FK rows whose
 * `salesperson` string unambiguously matches one StaffMember
 * (matching displayName or any entry in StaffMember.aliases).
 *
 * Returns the number of rows updated (0 when nothing matches or
 * everything is already backfilled).
 */
export async function backfillSalesPersonFk(prisma: PrismaClient): Promise<BackfillResult> {
  // The final NOT EXISTS honors the pay-period attribution lock: don't
  // set the FK on an order whose date falls in an ACTIVE confirmed
  // period for the very designer we'd be linking it to. Setting the FK
  // is part of attribution, and a locked period must stay frozen. See
  // docs/domains/commission.md "Pay-period confirmation + attribution
  // lock".
  const result = await prisma.$executeRaw`
    UPDATE "SalesOrder" so
    SET "salesPersonId" = matched.staff_id
    FROM (
      SELECT
        so.id AS order_id,
        MIN(sm.id) AS staff_id
      FROM "SalesOrder" so
      JOIN "StaffMember" sm
        ON LOWER(sm."displayName") = LOWER(TRIM(so.salesperson))
        OR LOWER(TRIM(so.salesperson)) = ANY(SELECT LOWER(a) FROM UNNEST(sm.aliases) AS a)
      WHERE so."salesPersonId" IS NULL
        AND so.salesperson IS NOT NULL
        AND so.salesperson <> ''
      GROUP BY so.id
      HAVING COUNT(DISTINCT sm.id) = 1
    ) matched
    WHERE so.id = matched.order_id
      AND so."salesPersonId" IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM "PayPeriodConfirmation" ppc
        WHERE ppc."reopenedAt" IS NULL
          AND ppc."staffMemberId" = matched.staff_id
          AND so."orderDate" >= ppc."periodStart"
          AND so."orderDate" < ppc."periodEnd" + INTERVAL '1 day'
      )
  `;

  return { updated: Number(result) };
}
