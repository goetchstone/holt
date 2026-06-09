// /app/__tests__/integration/commissionPayoutList.integration.test.ts
//
// Real-DB tests for the shared payout list query. The MANAGER team-
// commission view calls it with { designersOnly: true, includeDrafts:
// false } — it must return ONLY locked payouts for staff flagged
// isDesigner, never drafts or non-designers.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { listCommissionPayouts } from "@/lib/commissionPayoutList";

const PS = new Date("2026-05-03T00:00:00Z");
const PE = new Date("2026-05-16T00:00:00Z");

async function seedStaff(name: string, isDesigner: boolean): Promise<number> {
  const s = await prisma.staffMember.create({
    data: { displayName: name, role: "DESIGNER", isActive: true, isDesigner },
  });
  return s.id;
}

async function seedPayout(staffMemberId: number, commissionAmount: number, locked: boolean) {
  return prisma.commissionPayout.create({
    data: {
      staffMemberId,
      periodStart: PS,
      periodEnd: PE,
      periodSalesAmount: 10000,
      ytdSalesAtStart: 0,
      ytdSalesAtEnd: 10000,
      tierBreakdown: [],
      commissionAmount,
      tierDefinitionSnapshot: [],
      lockedAt: locked ? new Date() : null,
    },
  });
}

describe("listCommissionPayouts — real DB", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("designersOnly + locked-only returns just flagged designers' locked payouts", async () => {
    const a = await seedStaff("Designer A", true);
    const b = await seedStaff("Designer B", true);
    const c = await seedStaff("Non Designer C", false);
    await seedPayout(a, 500, true); // locked + designer → included
    await seedPayout(b, 300, false); // draft → excluded by locked-only
    await seedPayout(c, 900, true); // locked but NOT designer → excluded

    const rows = await listCommissionPayouts({ designersOnly: true, includeDrafts: false });
    expect(rows).toHaveLength(1);
    expect(rows[0].staffMemberId).toBe(a);
  });

  it("without filters returns drafts + non-designers too", async () => {
    const a = await seedStaff("Designer A", true);
    const c = await seedStaff("Non Designer C", false);
    await seedPayout(a, 300, false); // draft
    await seedPayout(c, 900, true); // locked non-designer

    const rows = await listCommissionPayouts({ designersOnly: false, includeDrafts: true });
    expect(rows).toHaveLength(2);
  });

  it("staffMemberId narrows to one designer", async () => {
    const a = await seedStaff("A", true);
    const b = await seedStaff("B", true);
    await seedPayout(a, 500, true);
    await seedPayout(b, 400, true);

    const rows = await listCommissionPayouts({ staffMemberId: a, designersOnly: true });
    expect(rows).toHaveLength(1);
    expect(rows[0].staffMemberId).toBe(a);
  });
});
