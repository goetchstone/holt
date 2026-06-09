// /app/__tests__/integration/runCommissionPayouts.integration.test.ts
//
// Real-DB integration tests for the commission-payout orchestrator.
// Covers the three entry points the API layer wraps:
//
//   - previewPayoutsForPeriod  — no writes; computes drafts from
//     SalesOrder + OrderLineItem
//   - commitPayoutsForPeriod   — writes upserts; respects sticky-lock
//   - editPayout               — edit-with-audit; one row per changed
//     field; lockedAt transitions stamp lockedBy
//
// The pure-math tests in __tests__/commissionPayout.test.ts pin the
// helper itself; this file proves the real Prisma queries (status
// filter, FK + alias OR'd match, split 0.5x, line-item filter, YTD
// boundaries) line up with the math.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import {
  previewPayoutsForPeriod,
  commitPayoutsForPeriod,
  editPayout,
  findOverlappingExistingPayouts,
  OverlappingPeriodError,
} from "@/lib/runCommissionPayouts";

const PERIOD_START = new Date("2026-05-16T00:00:00Z");
const PERIOD_END = new Date("2026-05-31T00:00:00Z");
const BEFORE_PERIOD = new Date("2026-03-15T00:00:00Z");

async function seedDesigner(opts: { displayName: string; aliases?: string[]; isActive?: boolean }) {
  return prisma.staffMember.create({
    data: {
      displayName: opts.displayName,
      aliases: opts.aliases ?? [],
      role: "DESIGNER",
      isActive: opts.isActive ?? true,
    },
  });
}

async function seedCustomer() {
  return prisma.customer.create({
    data: { firstName: "T", lastName: "Customer" },
  });
}

/**
 * Seed a SalesOrder + lines for a given designer/date. Status defaults
 * to ORDER so the canonical revenue filter picks it up.
 */
async function seedOrderForDesigner(opts: {
  orderno: string;
  customerId: number;
  staffId: number;
  splitWithId?: number;
  salespersonString?: string;
  orderDate: Date;
  netPrice: number;
  status?: "ORDER" | "FULFILLED" | "RETURNED" | "CANCELLED" | "QUOTE";
}) {
  return prisma.salesOrder.create({
    data: {
      orderno: opts.orderno,
      status: opts.status ?? "ORDER",
      orderDate: opts.orderDate,
      customerId: opts.customerId,
      salesPersonId: opts.staffId,
      splitWithId: opts.splitWithId ?? null,
      salesperson: opts.salespersonString ?? null,
      lineItems: {
        create: [
          {
            lineNumber: 1,
            netPrice: opts.netPrice,
            cost: 0,
            orderedQuantity: 1,
            lineItemStatus: "ACTIVE",
          },
        ],
      },
    },
  });
}

/**
 * Seed the default tier table so the orchestrator's loadTiers picks
 * up DB rows (not the fallback). Real prod has these seeded by
 * migration 20260519g_commission_tiers; we replay them here.
 */
async function seedDefaultTiers() {
  await prisma.commissionTier.createMany({
    data: [
      {
        label: "Up to $750k",
        minYtdSales: 0,
        maxYtdSalesExclusive: 750_000,
        rate: 0.03,
        sortOrder: 0,
      },
      {
        label: "$750k – $1M",
        minYtdSales: 750_000,
        maxYtdSalesExclusive: 1_000_000,
        rate: 0.04,
        sortOrder: 1,
      },
      {
        label: "$1M – $1.5M",
        minYtdSales: 1_000_000,
        maxYtdSalesExclusive: 1_500_000,
        rate: 0.05,
        sortOrder: 2,
      },
      {
        label: "$1.5M – $2M",
        minYtdSales: 1_500_000,
        maxYtdSalesExclusive: 2_000_000,
        rate: 0.06,
        sortOrder: 3,
      },
      {
        label: "Over $2M",
        minYtdSales: 2_000_000,
        maxYtdSalesExclusive: null,
        rate: 0.07,
        sortOrder: 4,
      },
    ],
  });
}

describe("previewPayoutsForPeriod (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
    await seedDefaultTiers();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("returns one row per active designer, sorted by commission desc", async () => {
    const customer = await seedCustomer();
    const alice = await seedDesigner({ displayName: "Alice" });
    const bob = await seedDesigner({ displayName: "Bob" });

    // Alice: $100k in period. YTD-start = 0, YTD-end = $100k → all at
    // 3% → $3000.
    await seedOrderForDesigner({
      orderno: "AL-1",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-20T00:00:00Z"),
      netPrice: 100_000,
    });
    // Bob: $50k in period at 3% → $1500.
    await seedOrderForDesigner({
      orderno: "BO-1",
      customerId: customer.id,
      staffId: bob.id,
      orderDate: new Date("2026-05-20T00:00:00Z"),
      netPrice: 50_000,
    });

    const drafts = await previewPayoutsForPeriod(PERIOD_START, PERIOD_END);
    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toMatchObject({
      displayName: "Alice",
      commissionAmount: 3000,
      periodSalesAmount: 100_000,
    });
    expect(drafts[1]).toMatchObject({
      displayName: "Bob",
      commissionAmount: 1500,
      periodSalesAmount: 50_000,
    });
  });

  it("excludes inactive designers", async () => {
    const customer = await seedCustomer();
    const alice = await seedDesigner({ displayName: "Alice" });
    await seedDesigner({ displayName: "Departed", isActive: false });

    await seedOrderForDesigner({
      orderno: "AL-1",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-20T00:00:00Z"),
      netPrice: 10_000,
    });

    const drafts = await previewPayoutsForPeriod(PERIOD_START, PERIOD_END);
    expect(drafts.map((d) => d.displayName)).toEqual(["Alice"]);
  });

  it("YTD-at-start = sales from Jan 1 through (periodStart - 1 day)", async () => {
    // The YTD-start cutoff is `lt: periodStart` (exclusive). Sales on
    // 2026-05-15 fall INSIDE YTD-start (since periodStart is 5/16);
    // sales on 5/16 fall OUTSIDE YTD-start but INSIDE YTD-end (since
    // periodEnd extends to 5/31).
    const customer = await seedCustomer();
    const alice = await seedDesigner({ displayName: "Alice" });

    // Pre-period: $700k YTD. Crosses the 750k threshold inside period.
    await seedOrderForDesigner({
      orderno: "AL-PRE",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: BEFORE_PERIOD,
      netPrice: 700_000,
    });
    // In-period: $100k. YTD goes 700k → 800k:
    //   $50k below 750k @ 3% = $1,500
    //   $50k above 750k @ 4% = $2,000
    //   total: $3,500
    await seedOrderForDesigner({
      orderno: "AL-IN",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-20T00:00:00Z"),
      netPrice: 100_000,
    });

    const drafts = await previewPayoutsForPeriod(PERIOD_START, PERIOD_END);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      ytdSalesAtStart: 700_000,
      ytdSalesAtEnd: 800_000,
      periodSalesAmount: 100_000,
      commissionAmount: 3500,
    });
  });

  it("returns net out: RETURNED order reduces period sales", async () => {
    const customer = await seedCustomer();
    const alice = await seedDesigner({ displayName: "Alice" });

    await seedOrderForDesigner({
      orderno: "AL-1",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-18T00:00:00Z"),
      netPrice: 100_000,
    });
    // Return SR-SAMPLE: negative netPrice line, status RETURNED. Same
    // staffId so the OR filter picks it up.
    await seedOrderForDesigner({
      orderno: "AL-A1",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-25T00:00:00Z"),
      netPrice: -30_000,
      status: "RETURNED",
    });

    const drafts = await previewPayoutsForPeriod(PERIOD_START, PERIOD_END);
    expect(drafts[0]).toMatchObject({
      periodSalesAmount: 70_000,
      commissionAmount: 70_000 * 0.03, // 2100
    });
  });

  it("excludes QUOTE and CANCELLED orders from sales", async () => {
    const customer = await seedCustomer();
    const alice = await seedDesigner({ displayName: "Alice" });

    await seedOrderForDesigner({
      orderno: "AL-1",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-20T00:00:00Z"),
      netPrice: 25_000,
    });
    await seedOrderForDesigner({
      orderno: "AL-Q",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-20T00:00:00Z"),
      netPrice: 99_999,
      status: "QUOTE",
    });
    await seedOrderForDesigner({
      orderno: "AL-X",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-20T00:00:00Z"),
      netPrice: 99_999,
      status: "CANCELLED",
    });

    const drafts = await previewPayoutsForPeriod(PERIOD_START, PERIOD_END);
    expect(drafts[0]).toMatchObject({
      periodSalesAmount: 25_000,
      commissionAmount: 750, // 25000 * 0.03
    });
  });

  it("split orders count 0.5× per partner", async () => {
    const customer = await seedCustomer();
    const alice = await seedDesigner({ displayName: "Alice" });
    const bob = await seedDesigner({ displayName: "Bob" });

    // Single order split between Alice (primary) and Bob.
    await seedOrderForDesigner({
      orderno: "SPLIT-1",
      customerId: customer.id,
      staffId: alice.id,
      splitWithId: bob.id,
      orderDate: new Date("2026-05-20T00:00:00Z"),
      netPrice: 100_000,
    });

    const drafts = await previewPayoutsForPeriod(PERIOD_START, PERIOD_END);
    const al = drafts.find((d) => d.displayName === "Alice");
    const bo = drafts.find((d) => d.displayName === "Bob");
    expect(al?.periodSalesAmount).toBe(50_000);
    expect(bo?.periodSalesAmount).toBe(50_000);
    expect(al?.commissionAmount).toBe(1500);
    expect(bo?.commissionAmount).toBe(1500);
  });

  it("matches by the POS salesperson string when FK is NULL", async () => {
    // Mirrors CLAUDE.md rule on imported orders where salesPersonId
    // is NULL but the salesperson string carries the name. Use
    // aliases to additionally match a variant spelling.
    const customer = await seedCustomer();
    const sandra = await seedDesigner({
      displayName: "Sandra Matheny",
      aliases: ["Sandy"],
    });

    // FK NULL, string equals displayName.
    await prisma.salesOrder.create({
      data: {
        orderno: "SAN-1",
        status: "ORDER",
        orderDate: new Date("2026-05-18T00:00:00Z"),
        customerId: customer.id,
        salesPersonId: null,
        salesperson: "Sandra Matheny",
        lineItems: {
          create: [
            {
              lineNumber: 1,
              netPrice: 10_000,
              cost: 0,
              orderedQuantity: 1,
              lineItemStatus: "ACTIVE",
            },
          ],
        },
      },
    });
    // FK NULL, string matches alias (case-insensitive).
    await prisma.salesOrder.create({
      data: {
        orderno: "SAN-2",
        status: "ORDER",
        orderDate: new Date("2026-05-20T00:00:00Z"),
        customerId: customer.id,
        salesPersonId: null,
        salesperson: "sandy",
        lineItems: {
          create: [
            {
              lineNumber: 1,
              netPrice: 5_000,
              cost: 0,
              orderedQuantity: 1,
              lineItemStatus: "ACTIVE",
            },
          ],
        },
      },
    });

    const drafts = await previewPayoutsForPeriod(PERIOD_START, PERIOD_END);
    const s = drafts.find((d) => d.displayName === "Sandra Matheny");
    expect(s).toBeDefined();
    expect(s?.staffMemberId).toBe(sandra.id);
    expect(s?.periodSalesAmount).toBe(15_000);
  });
});

describe("commitPayoutsForPeriod (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
    await seedDefaultTiers();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("creates new payouts from the preview", async () => {
    const customer = await seedCustomer();
    const alice = await seedDesigner({ displayName: "Alice" });
    await seedOrderForDesigner({
      orderno: "AL-1",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-20T00:00:00Z"),
      netPrice: 100_000,
    });

    const result = await commitPayoutsForPeriod(PERIOD_START, PERIOD_END, [], {
      lockNow: false,
      actorEmail: "admin@example.com",
    });
    expect(result.created).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.payoutIds).toHaveLength(1);

    const row = await prisma.commissionPayout.findUnique({ where: { id: result.payoutIds[0] } });
    expect(row).not.toBeNull();
    expect(Number(row!.commissionAmount)).toBe(3000);
    expect(Number(row!.periodSalesAmount)).toBe(100_000);
    expect(row!.lockedAt).toBeNull();
    expect(row!.createdBy).toBe("admin@example.com");
    expect(row!.tierBreakdown).toEqual([
      { tierLabel: "Up to $750k", rate: 0.03, sliceAmount: 100_000, sliceCommission: 3000 },
    ]);
  });

  it("upserts in place when re-run on the same period (no lock)", async () => {
    const customer = await seedCustomer();
    const alice = await seedDesigner({ displayName: "Alice" });
    await seedOrderForDesigner({
      orderno: "AL-1",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-20T00:00:00Z"),
      netPrice: 100_000,
    });

    const first = await commitPayoutsForPeriod(PERIOD_START, PERIOD_END, [], {
      lockNow: false,
      actorEmail: "admin@example.com",
    });
    expect(first.created).toBe(1);

    // Now a refund lands → period sales drops → re-commit updates the
    // existing draft row in place.
    await seedOrderForDesigner({
      orderno: "AL-A1",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-25T00:00:00Z"),
      netPrice: -40_000,
      status: "RETURNED",
    });
    const second = await commitPayoutsForPeriod(PERIOD_START, PERIOD_END, [], {
      lockNow: false,
      actorEmail: "admin@example.com",
    });
    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);
    expect(second.payoutIds[0]).toBe(first.payoutIds[0]);

    const updated = await prisma.commissionPayout.findUnique({ where: { id: first.payoutIds[0] } });
    expect(Number(updated!.periodSalesAmount)).toBe(60_000);
    expect(Number(updated!.commissionAmount)).toBe(60_000 * 0.03);
  });

  it("locks rows when lockNow=true; subsequent re-commit does NOT overwrite locked rows", async () => {
    const customer = await seedCustomer();
    const alice = await seedDesigner({ displayName: "Alice" });
    await seedOrderForDesigner({
      orderno: "AL-1",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-20T00:00:00Z"),
      netPrice: 100_000,
    });

    const first = await commitPayoutsForPeriod(PERIOD_START, PERIOD_END, [], {
      lockNow: true,
      actorEmail: "admin@example.com",
    });
    const beforeRow = await prisma.commissionPayout.findUnique({
      where: { id: first.payoutIds[0] },
    });
    expect(beforeRow!.lockedAt).not.toBeNull();
    expect(beforeRow!.lockedBy).toBe("admin@example.com");
    const lockedCommission = Number(beforeRow!.commissionAmount);

    // New return lands; re-commit should SKIP the locked row.
    await seedOrderForDesigner({
      orderno: "AL-A1",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-26T00:00:00Z"),
      netPrice: -40_000,
      status: "RETURNED",
    });
    const second = await commitPayoutsForPeriod(PERIOD_START, PERIOD_END, [], {
      lockNow: false,
      actorEmail: "admin@example.com",
    });
    expect(second.created).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.payoutIds).toEqual(first.payoutIds);

    const afterRow = await prisma.commissionPayout.findUnique({
      where: { id: first.payoutIds[0] },
    });
    expect(Number(afterRow!.commissionAmount)).toBe(lockedCommission);
    expect(afterRow!.lockedAt).not.toBeNull();
  });

  it("applies operator overrides for commissionAmount + notes + paidOn", async () => {
    const customer = await seedCustomer();
    const alice = await seedDesigner({ displayName: "Alice" });
    await seedOrderForDesigner({
      orderno: "AL-1",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-20T00:00:00Z"),
      netPrice: 100_000,
    });

    const paidOn = new Date("2026-06-15T00:00:00Z");
    const result = await commitPayoutsForPeriod(
      PERIOD_START,
      PERIOD_END,
      [
        {
          staffMemberId: alice.id,
          commissionAmount: 4200,
          notes: "Bumped per Tom",
          paidOn,
        },
      ],
      { lockNow: false, actorEmail: "admin@example.com" },
    );
    const row = await prisma.commissionPayout.findUnique({ where: { id: result.payoutIds[0] } });
    expect(Number(row!.commissionAmount)).toBe(4200);
    expect(row!.notes).toBe("Bumped per Tom");
    expect(row!.paidOn?.toISOString()).toBe(paidOn.toISOString());
  });
});

describe("editPayout (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
    await seedDefaultTiers();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedLockedPayout() {
    const customer = await seedCustomer();
    const alice = await seedDesigner({ displayName: "Alice" });
    await seedOrderForDesigner({
      orderno: "AL-1",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-20T00:00:00Z"),
      netPrice: 100_000,
    });
    const result = await commitPayoutsForPeriod(PERIOD_START, PERIOD_END, [], {
      lockNow: true,
      actorEmail: "admin@example.com",
    });
    return { payoutId: result.payoutIds[0], aliceId: alice.id };
  }

  it("rejects edit when reason is empty", async () => {
    const { payoutId } = await seedLockedPayout();
    await expect(
      editPayout(payoutId, { commissionAmount: 9999 }, { reason: "  ", editedBy: "boss@x.com" }),
    ).rejects.toThrow(/audit reason is required/);

    // Confirm nothing was written.
    const row = await prisma.commissionPayout.findUnique({ where: { id: payoutId } });
    expect(Number(row!.commissionAmount)).toBe(3000);
    const edits = await prisma.commissionPayoutEdit.findMany({ where: { payoutId } });
    expect(edits).toHaveLength(0);
  });

  it("rejects edit when payout is missing", async () => {
    await expect(
      editPayout(99999, { commissionAmount: 1 }, { reason: "x", editedBy: "boss@x.com" }),
    ).rejects.toThrow(/payout not found/);
  });

  it("writes one audit row per changed field; reason + editedBy stamped", async () => {
    const { payoutId } = await seedLockedPayout();
    const paidOn = new Date("2026-06-10T00:00:00Z");

    const result = await editPayout(
      payoutId,
      { commissionAmount: 3500, notes: "True-up after audit", paidOn },
      { reason: "Year-end audit found extra $500", editedBy: "boss@example.com" },
    );
    expect(result.editsRecorded).toBe(3);

    const edits = await prisma.commissionPayoutEdit.findMany({
      where: { payoutId },
      orderBy: { fieldChanged: "asc" },
    });
    expect(edits.map((e) => e.fieldChanged).sort()).toEqual([
      "commissionAmount",
      "notes",
      "paidOn",
    ]);
    for (const e of edits) {
      expect(e.reason).toBe("Year-end audit found extra $500");
      expect(e.editedBy).toBe("boss@example.com");
    }

    const row = await prisma.commissionPayout.findUnique({ where: { id: payoutId } });
    expect(Number(row!.commissionAmount)).toBe(3500);
    expect(row!.notes).toBe("True-up after audit");
    expect(row!.paidOn?.toISOString()).toBe(paidOn.toISOString());
    expect(row!.updatedBy).toBe("boss@example.com");
  });

  it("no-op edit (same values) records zero audit rows and doesn't touch the row", async () => {
    const { payoutId } = await seedLockedPayout();
    const before = await prisma.commissionPayout.findUnique({ where: { id: payoutId } });

    const result = await editPayout(
      payoutId,
      { commissionAmount: Number(before!.commissionAmount), notes: before!.notes },
      { reason: "double-check", editedBy: "boss@example.com" },
    );
    expect(result.editsRecorded).toBe(0);

    const edits = await prisma.commissionPayoutEdit.findMany({ where: { payoutId } });
    expect(edits).toHaveLength(0);
  });

  it("lockedAt: null unlocks the row and clears lockedBy; audit row recorded", async () => {
    const { payoutId } = await seedLockedPayout();
    const before = await prisma.commissionPayout.findUnique({ where: { id: payoutId } });
    expect(before!.lockedAt).not.toBeNull();

    const result = await editPayout(
      payoutId,
      { lockedAt: null },
      { reason: "Owner asked to unlock for a correction", editedBy: "boss@x.com" },
    );
    expect(result.editsRecorded).toBe(1);

    const after = await prisma.commissionPayout.findUnique({ where: { id: payoutId } });
    expect(after!.lockedAt).toBeNull();
    expect(after!.lockedBy).toBeNull();

    const edits = await prisma.commissionPayoutEdit.findMany({ where: { payoutId } });
    expect(edits).toHaveLength(1);
    expect(edits[0].fieldChanged).toBe("lockedAt");
    expect(edits[0].reason).toContain("unlock");
  });

  it("lockedAt: Date re-locks an unlocked row and stamps lockedBy from editedBy", async () => {
    const { payoutId } = await seedLockedPayout();
    // Unlock first.
    await editPayout(
      payoutId,
      { lockedAt: null },
      { reason: "unlock for fix", editedBy: "boss@x.com" },
    );
    // Then re-lock by a different operator — confirms lockedBy follows
    // editedBy on the new lock.
    const lockTime = new Date("2026-06-01T12:00:00Z");
    await editPayout(
      payoutId,
      { lockedAt: lockTime },
      { reason: "re-lock after fix", editedBy: "owner@example.com" },
    );

    const row = await prisma.commissionPayout.findUnique({ where: { id: payoutId } });
    expect(row!.lockedAt?.toISOString()).toBe(lockTime.toISOString());
    expect(row!.lockedBy).toBe("owner@example.com");

    const edits = await prisma.commissionPayoutEdit.findMany({
      where: { payoutId },
      orderBy: { editedAt: "asc" },
    });
    // 1 unlock + 1 re-lock
    expect(edits.filter((e) => e.fieldChanged === "lockedAt")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Chain continuity — period N+1's ytdAtStart reads from period N's
// frozen ytdSalesAtEnd when N is locked. Late-landing returns inside
// the locked period DON'T re-credit the next period.
// ---------------------------------------------------------------------------

describe("chain continuity across locked periods", () => {
  const PERIOD_1_START = new Date("2026-05-01T00:00:00Z");
  const PERIOD_1_END = new Date("2026-05-15T00:00:00Z");
  const PERIOD_2_START = new Date("2026-05-16T00:00:00Z");
  const PERIOD_2_END = new Date("2026-05-31T00:00:00Z");

  beforeEach(async () => {
    await resetTestDb();
    await seedDefaultTiers();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("period N+1's ytdAtStart equals period N's frozen ytdSalesAtEnd after a late return", async () => {
    const customer = await seedCustomer();
    const alice = await seedDesigner({ displayName: "Alice" });

    // Period 1: Alice does $750k of sales. Lock it.
    await seedOrderForDesigner({
      orderno: "AL-P1",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-05T00:00:00Z"),
      netPrice: 750_000,
    });
    const lockResult = await commitPayoutsForPeriod(PERIOD_1_START, PERIOD_1_END, [], {
      lockNow: true,
      actorEmail: "admin@x.com",
    });
    expect(lockResult.created).toBe(1);
    const lockedRow = await prisma.commissionPayout.findUnique({
      where: { id: lockResult.payoutIds[0] },
    });
    expect(Number(lockedRow!.ytdSalesAtEnd)).toBe(750_000);
    expect(Number(lockedRow!.commissionAmount)).toBe(22_500);

    // Period 2 starts. Alice does another $100k.
    await seedOrderForDesigner({
      orderno: "AL-P2",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-20T00:00:00Z"),
      netPrice: 100_000,
    });
    // Then a $50k return lands — dated 5/22 (inside period 2) so it's
    // in period 2's slice, NOT a stealth period-1 mutation.
    await seedOrderForDesigner({
      orderno: "AL-RET",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-22T00:00:00Z"),
      netPrice: -50_000,
      status: "RETURNED",
    });

    const drafts = await previewPayoutsForPeriod(PERIOD_2_START, PERIOD_2_END);
    expect(drafts).toHaveLength(1);
    // ytdAtStart comes from the LOCK (750k), not from live recompute.
    expect(drafts[0].ytdSalesAtStart).toBe(750_000);
    // ytdAtEnd is live: 750k (period 1) + 100k (period 2 sale) - 50k
    // (period 2 return) = 800k.
    expect(drafts[0].ytdSalesAtEnd).toBe(800_000);
    // Slice = 800k - 750k = 50k. Lands entirely in the 4% tier
    // ($750k-$1M). So commission = $50k × 4% = $2,000.
    expect(drafts[0].periodSalesAmount).toBe(50_000);
    expect(drafts[0].commissionAmount).toBe(2_000);
    // Full-year correctness check: 22,500 (period 1) + 2,000 (period 2)
    // = $24,500. That matches marginal-on-cumulative-YTD: 750k @ 3% +
    // 50k @ 4% = 24,500. Chain continuity preserved Alice's true total.
  });

  it("when an SR-SAMPLE return lands AFTER lock with a date INSIDE the locked period, period N+1 still chains correctly", async () => {
    // The hard case: return dated 5/3 (in period 1) imported on 5/20
    // (after period 1 locked). Live recompute of period 1's
    // ytd-at-end would now show 700k. But chain continuity reads the
    // lock's frozen ytdAtEnd (750k), so period 2 picks up where the
    // lock left off — NOT where the live data now stands. The
    // discrepancy surfaces in the drift report, not by silently
    // re-shifting Alice's commission.
    const customer = await seedCustomer();
    const alice = await seedDesigner({ displayName: "Alice" });

    await seedOrderForDesigner({
      orderno: "AL-P1",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-05T00:00:00Z"),
      netPrice: 750_000,
    });
    const lockResult = await commitPayoutsForPeriod(PERIOD_1_START, PERIOD_1_END, [], {
      lockNow: true,
      actorEmail: "admin@x.com",
    });

    // SR-SAMPLE return dated 5/03 (inside period 1) but imported after the
    // lock. Date is inside period 1's range.
    await seedOrderForDesigner({
      orderno: "AL-SR-SAMPLE",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-03T00:00:00Z"),
      netPrice: -50_000,
      status: "RETURNED",
    });
    await seedOrderForDesigner({
      orderno: "AL-P2",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-20T00:00:00Z"),
      netPrice: 100_000,
    });

    const drafts = await previewPayoutsForPeriod(PERIOD_2_START, PERIOD_2_END);
    // ytdAtStart still reads from the lock — NOT from the live data
    // (which now reflects the SR-SAMPLE and would show 700k).
    expect(drafts[0].ytdSalesAtStart).toBe(750_000);
    // ytdAtEnd is live: 750k - 50k + 100k = 800k.
    expect(drafts[0].ytdSalesAtEnd).toBe(800_000);
    // Period 2 commission still $2,000.
    expect(drafts[0].commissionAmount).toBe(2_000);

    // Locked row is unchanged.
    const stillLocked = await prisma.commissionPayout.findUnique({
      where: { id: lockResult.payoutIds[0] },
    });
    expect(Number(stillLocked!.ytdSalesAtEnd)).toBe(750_000);
    expect(Number(stillLocked!.commissionAmount)).toBe(22_500);
  });

  it("falls back to live recompute when NO prior lock exists for this designer", async () => {
    const customer = await seedCustomer();
    const alice = await seedDesigner({ displayName: "Alice" });
    // Pre-period sales (live data only — never locked).
    await seedOrderForDesigner({
      orderno: "AL-PRE",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-03-15T00:00:00Z"),
      netPrice: 200_000,
    });
    await seedOrderForDesigner({
      orderno: "AL-P2",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-20T00:00:00Z"),
      netPrice: 100_000,
    });
    const drafts = await previewPayoutsForPeriod(PERIOD_2_START, PERIOD_2_END);
    // No lock to chain from → ytdAtStart comes from live.
    expect(drafts[0].ytdSalesAtStart).toBe(200_000);
    expect(drafts[0].ytdSalesAtEnd).toBe(300_000);
  });

  it("ignores DRAFT prior payouts — only LOCKED rows pin the chain", async () => {
    const customer = await seedCustomer();
    const alice = await seedDesigner({ displayName: "Alice" });
    await seedOrderForDesigner({
      orderno: "AL-P1",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-05T00:00:00Z"),
      netPrice: 750_000,
    });
    // Period 1 saved as DRAFT (not locked).
    await commitPayoutsForPeriod(PERIOD_1_START, PERIOD_1_END, [], {
      lockNow: false,
      actorEmail: "admin@x.com",
    });
    // Late SR-SAMPLE inside period 1 lands after the draft.
    await seedOrderForDesigner({
      orderno: "AL-SR-SAMPLE",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-03T00:00:00Z"),
      netPrice: -50_000,
      status: "RETURNED",
    });
    await seedOrderForDesigner({
      orderno: "AL-P2",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-20T00:00:00Z"),
      netPrice: 100_000,
    });

    const drafts = await previewPayoutsForPeriod(PERIOD_2_START, PERIOD_2_END);
    // No LOCKED row → ytdAtStart comes from LIVE (now 700k after SR-SAMPLE).
    expect(drafts[0].ytdSalesAtStart).toBe(700_000);
    expect(drafts[0].ytdSalesAtEnd).toBe(800_000);
  });

  it("year boundary: a Dec-2025 lock does NOT carry into 2026 period chains", async () => {
    const customer = await seedCustomer();
    const alice = await seedDesigner({ displayName: "Alice" });

    // 2025 sale + 2025 lock.
    await seedOrderForDesigner({
      orderno: "AL-2025",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2025-12-10T00:00:00Z"),
      netPrice: 500_000,
    });
    await commitPayoutsForPeriod(
      new Date("2025-12-01T00:00:00Z"),
      new Date("2025-12-31T00:00:00Z"),
      [],
      { lockNow: true, actorEmail: "admin@x.com" },
    );

    // 2026 — no prior 2026 lock. The 2025 lock should NOT be picked up.
    await seedOrderForDesigner({
      orderno: "AL-2026",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-01-15T00:00:00Z"),
      netPrice: 100_000,
    });
    const drafts = await previewPayoutsForPeriod(
      new Date("2026-02-01T00:00:00Z"),
      new Date("2026-02-15T00:00:00Z"),
    );
    // 2026 YTD only — the Jan sale counts; nothing carries from 2025.
    expect(drafts[0].ytdSalesAtStart).toBe(100_000);
    expect(drafts[0].ytdSalesAtEnd).toBe(100_000);
  });
});

// ---------------------------------------------------------------------------
// Overlap guard — once a pay period is drafted or locked, generating a
// NEW range that overlaps it is refused. Owner direction 2026-05-27:
// "once we have a payperiord drafted or locked we should not be able
// to generate new data against it."
// ---------------------------------------------------------------------------

describe("pay-period overlap guard", () => {
  const P1_START = new Date("2026-05-01T00:00:00Z");
  const P1_END = new Date("2026-05-15T00:00:00Z");

  beforeEach(async () => {
    await resetTestDb();
    await seedDefaultTiers();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("findOverlappingExistingPayouts returns [] before any payouts exist", async () => {
    const result = await findOverlappingExistingPayouts(P1_START, P1_END);
    expect(result).toEqual([]);
  });

  it("commitPayoutsForPeriod throws OverlappingPeriodError when the range overlaps a LOCKED period", async () => {
    const customer = await seedCustomer();
    const alice = await seedDesigner({ displayName: "Alice" });
    await seedOrderForDesigner({
      orderno: "AL-P1",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-05T00:00:00Z"),
      netPrice: 100_000,
    });
    await commitPayoutsForPeriod(P1_START, P1_END, [], {
      lockNow: true,
      actorEmail: "admin@x.com",
    });

    // Now try to generate an overlapping range: 5/10 – 5/25.
    await expect(
      commitPayoutsForPeriod(
        new Date("2026-05-10T00:00:00Z"),
        new Date("2026-05-25T00:00:00Z"),
        [],
        { lockNow: false, actorEmail: "admin@x.com" },
      ),
    ).rejects.toBeInstanceOf(OverlappingPeriodError);

    // And confirm no new rows landed — the operator can't trick the
    // system by ignoring the error.
    const rows = await prisma.commissionPayout.findMany();
    expect(rows).toHaveLength(1);
  });

  it("commitPayoutsForPeriod throws when the range overlaps a DRAFT period (not just locked)", async () => {
    const customer = await seedCustomer();
    const alice = await seedDesigner({ displayName: "Alice" });
    await seedOrderForDesigner({
      orderno: "AL-P1",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-05T00:00:00Z"),
      netPrice: 100_000,
    });
    // Save period 1 as DRAFT (not locked) — the guard still fires.
    await commitPayoutsForPeriod(P1_START, P1_END, [], {
      lockNow: false,
      actorEmail: "admin@x.com",
    });

    await expect(
      commitPayoutsForPeriod(
        new Date("2026-05-10T00:00:00Z"),
        new Date("2026-05-20T00:00:00Z"),
        [],
        { lockNow: false, actorEmail: "admin@x.com" },
      ),
    ).rejects.toThrow(/overlaps/i);
  });

  it("commitPayoutsForPeriod allows an EXACT re-run of the same period (idempotent path)", async () => {
    const customer = await seedCustomer();
    const alice = await seedDesigner({ displayName: "Alice" });
    await seedOrderForDesigner({
      orderno: "AL-P1",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-05T00:00:00Z"),
      netPrice: 100_000,
    });
    await commitPayoutsForPeriod(P1_START, P1_END, [], {
      lockNow: false,
      actorEmail: "admin@x.com",
    });
    // Same dates → existing row UPDATEs in place; no error.
    const second = await commitPayoutsForPeriod(P1_START, P1_END, [], {
      lockNow: false,
      actorEmail: "admin@x.com",
    });
    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);
  });

  it("commitPayoutsForPeriod allows an ADJACENT period (the chain-continuity path)", async () => {
    const customer = await seedCustomer();
    const alice = await seedDesigner({ displayName: "Alice" });
    await seedOrderForDesigner({
      orderno: "AL-P1",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-05T00:00:00Z"),
      netPrice: 100_000,
    });
    await commitPayoutsForPeriod(P1_START, P1_END, [], {
      lockNow: true,
      actorEmail: "admin@x.com",
    });
    // Period 2 starts the day after period 1 ends — no overlap.
    const second = await commitPayoutsForPeriod(
      new Date("2026-05-16T00:00:00Z"),
      new Date("2026-05-31T00:00:00Z"),
      [],
      { lockNow: false, actorEmail: "admin@x.com" },
    );
    expect(second.created).toBe(1);
  });

  it("OverlappingPeriodError.overlaps carries the conflicting payouts (id, designer, dates, lockedAt)", async () => {
    const customer = await seedCustomer();
    const alice = await seedDesigner({ displayName: "Alice" });
    await seedOrderForDesigner({
      orderno: "AL-P1",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-05T00:00:00Z"),
      netPrice: 100_000,
    });
    const first = await commitPayoutsForPeriod(P1_START, P1_END, [], {
      lockNow: true,
      actorEmail: "admin@x.com",
    });

    try {
      await commitPayoutsForPeriod(
        new Date("2026-05-12T00:00:00Z"),
        new Date("2026-05-25T00:00:00Z"),
        [],
        { lockNow: false, actorEmail: "admin@x.com" },
      );
      throw new Error("commit should have rejected");
    } catch (err) {
      expect(err).toBeInstanceOf(OverlappingPeriodError);
      const oerr = err as OverlappingPeriodError;
      expect(oerr.overlaps).toHaveLength(1);
      expect(oerr.overlaps[0].id).toBe(first.payoutIds[0]);
      expect(oerr.overlaps[0].staffMemberDisplayName).toBe("Alice");
      expect(oerr.overlaps[0].lockedAt).not.toBeNull();
    }
  });
});
