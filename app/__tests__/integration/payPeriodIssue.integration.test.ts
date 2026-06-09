// /app/__tests__/integration/payPeriodIssue.integration.test.ts
//
// Real-DB tests for the pay-period "report an issue" flag. A designer
// flags wrong numbers instead of confirming; the flag shows on the
// manager grid (does NOT lock the period) and a manager resolves it.
//
// Scenarios:
//   1. report → an OPEN issue row exists; reporting again is idempotent
//      (no duplicate while one is open).
//   2. the manager status grid surfaces the open issue + blocks the
//      "ready for review" all-clear.
//   3. resolve → the flag clears; getOpenIssueSummary drops to zero.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import {
  reportPayPeriodIssue,
  resolvePayPeriodIssue,
  getOpenIssueSummary,
  listPeriodConfirmationStatus,
  confirmPayPeriod,
} from "@/lib/payPeriodConfirmationService";
import { payPeriodForDate } from "@/lib/payPeriod";

// A date inside a CLOSED period (period 0 = 5/03–5/16/2026), so confirm
// is allowed and the period math is deterministic.
const PERIOD = payPeriodForDate(new Date("2026-05-10T00:00:00Z"));

async function seedDesigner(displayName: string): Promise<number> {
  const s = await prisma.staffMember.create({
    data: { displayName, role: "DESIGNER", isActive: true, isDesigner: true },
  });
  return s.id;
}

describe("pay-period issue flag — real DB", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("reports an issue and is idempotent while one is open", async () => {
    const staffId = await seedDesigner("Issue Tester");

    const first = await reportPayPeriodIssue({
      staffMemberId: staffId,
      period: PERIOD,
      note: "Two orders are missing from my total",
      reportedBy: "designer@example.com",
    });
    expect(first.alreadyOpen).toBe(false);

    // Reporting again while the first is still open returns the same row.
    const second = await reportPayPeriodIssue({
      staffMemberId: staffId,
      period: PERIOD,
      note: "still wrong",
      reportedBy: "designer@example.com",
    });
    expect(second.alreadyOpen).toBe(true);
    expect(second.id).toBe(first.id);

    const rows = await prisma.payPeriodIssue.count({ where: { staffMemberId: staffId } });
    expect(rows).toBe(1);

    const summary = await getOpenIssueSummary(staffId, PERIOD);
    expect(summary.openCount).toBe(1);
    expect(summary.note).toBe("Two orders are missing from my total");
  });

  it("surfaces the open issue on the manager grid and blocks ready-for-review", async () => {
    const staffId = await seedDesigner("Grid Tester");
    await reportPayPeriodIssue({
      staffMemberId: staffId,
      period: PERIOD,
      note: "wrong split %",
      reportedBy: "designer@example.com",
    });

    const { rows, readyForReview } = await listPeriodConfirmationStatus(PERIOD);
    const row = rows.find((r) => r.staffMemberId === staffId);
    expect(row?.openIssue).not.toBeNull();
    expect(row?.openIssue?.note).toBe("wrong split %");
    expect(row?.isLocked).toBe(false);
    // An open issue keeps the period from being "ready for review".
    expect(readyForReview).toBe(false);
  });

  it("resolving the issue clears the flag; confirm then locks cleanly", async () => {
    const staffId = await seedDesigner("Resolve Tester");
    const reported = await reportPayPeriodIssue({
      staffMemberId: staffId,
      period: PERIOD,
      note: "fix me",
      reportedBy: "designer@example.com",
    });

    await resolvePayPeriodIssue({
      issueId: reported.id,
      resolvedBy: "manager@example.com",
      resolutionNote: "reassigned the order",
    });

    const row = await prisma.payPeriodIssue.findUnique({ where: { id: reported.id } });
    expect(row?.resolvedAt).not.toBeNull();
    expect(row?.resolvedBy).toBe("manager@example.com");

    const summary = await getOpenIssueSummary(staffId, PERIOD);
    expect(summary.openCount).toBe(0);

    // With the only designer's issue resolved AND confirmed, the grid is
    // ready for review.
    await confirmPayPeriod({
      staffMemberId: staffId,
      period: PERIOD,
      confirmedBy: "manager@example.com",
    });
    const { readyForReview } = await listPeriodConfirmationStatus(PERIOD);
    expect(readyForReview).toBe(true);
  });
});
