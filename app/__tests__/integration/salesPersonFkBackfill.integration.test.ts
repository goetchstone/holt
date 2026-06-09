// /app/__tests__/integration/salesPersonFkBackfill.integration.test.ts
//
// Real-DB tests for `backfillSalesPersonFk` — the post-import sweep
// that fills `SalesOrder.salesPersonId` from the `salesperson` string
// via StaffMember displayName + aliases match.
//
// CRITICAL because the matching logic is in raw SQL (Prisma's
// case-insensitive matching is verbose; UNNEST(aliases) needs
// Postgres). A mocked-Prisma test would prove nothing about whether
// the actual JOIN behavior is correct.
//
// Origin: Issue #274 follow-up, ROADMAP Short-Term #12 wrap.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { backfillSalesPersonFk } from "@/lib/salesPersonFkBackfill";

describe("backfillSalesPersonFk — real-DB", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("sets salesPersonId when salesperson string matches displayName", async () => {
    const staff = await prisma.staffMember.create({
      data: { displayName: "Cheryl Homan", role: "DESIGNER" },
    });
    const order = await prisma.salesOrder.create({
      data: {
        orderno: "SO-MATCH-NAME",
        salesperson: "Cheryl Homan",
        salesPersonId: null,
      },
    });

    const result = await backfillSalesPersonFk(prisma);

    expect(result.updated).toBe(1);
    const reloaded = await prisma.salesOrder.findUnique({ where: { id: order.id } });
    expect(reloaded?.salesPersonId).toBe(staff.id);
  });

  it("sets salesPersonId when salesperson string matches an alias (the Sandy case)", async () => {
    const sandy = await prisma.staffMember.create({
      data: {
        displayName: "Sandy",
        aliases: ["Sandra Matheny"],
        role: "MANAGER",
      },
    });
    const order = await prisma.salesOrder.create({
      data: {
        orderno: "SO-MATCH-ALIAS",
        salesperson: "Sandra Matheny",
        salesPersonId: null,
      },
    });

    const result = await backfillSalesPersonFk(prisma);

    expect(result.updated).toBe(1);
    const reloaded = await prisma.salesOrder.findUnique({ where: { id: order.id } });
    expect(reloaded?.salesPersonId).toBe(sandy.id);
  });

  it("matches case-insensitively and trims whitespace", async () => {
    const staff = await prisma.staffMember.create({
      data: { displayName: "Karen West", role: "DESIGNER" },
    });
    const order = await prisma.salesOrder.create({
      data: {
        orderno: "SO-CASE-WHITESPACE",
        salesperson: "  karen WEST  ",
        salesPersonId: null,
      },
    });

    const result = await backfillSalesPersonFk(prisma);

    expect(result.updated).toBe(1);
    const reloaded = await prisma.salesOrder.findUnique({ where: { id: order.id } });
    expect(reloaded?.salesPersonId).toBe(staff.id);
  });

  it("skips when salesperson string matches NO StaffMember", async () => {
    const order = await prisma.salesOrder.create({
      data: {
        orderno: "SO-NO-MATCH",
        salesperson: "OSRegister1",
        salesPersonId: null,
      },
    });

    const result = await backfillSalesPersonFk(prisma);

    expect(result.updated).toBe(0);
    const reloaded = await prisma.salesOrder.findUnique({ where: { id: order.id } });
    expect(reloaded?.salesPersonId).toBeNull();
  });

  it("skips ambiguous matches (two staff with the same displayName)", async () => {
    await prisma.staffMember.create({
      data: { displayName: "Jordan", role: "DESIGNER" },
    });
    await prisma.staffMember.create({
      data: { displayName: "Jordan", role: "DESIGNER", email: "j2@example.com" },
    });
    const order = await prisma.salesOrder.create({
      data: {
        orderno: "SO-AMBIGUOUS",
        salesperson: "Jordan",
        salesPersonId: null,
      },
    });

    const result = await backfillSalesPersonFk(prisma);

    expect(result.updated).toBe(0);
    const reloaded = await prisma.salesOrder.findUnique({ where: { id: order.id } });
    expect(reloaded?.salesPersonId).toBeNull();
  });

  it("does not touch orders that already have salesPersonId set", async () => {
    const staff = await prisma.staffMember.create({
      data: { displayName: "Pre-set Staff", role: "DESIGNER" },
    });
    const other = await prisma.staffMember.create({
      data: { displayName: "Other Staff", role: "DESIGNER", email: "o@example.com" },
    });
    const order = await prisma.salesOrder.create({
      data: {
        orderno: "SO-PRESET",
        salesperson: "Other Staff",
        salesPersonId: staff.id,
      },
    });

    const result = await backfillSalesPersonFk(prisma);

    expect(result.updated).toBe(0);
    const reloaded = await prisma.salesOrder.findUnique({ where: { id: order.id } });
    expect(reloaded?.salesPersonId).toBe(staff.id);
    expect(reloaded?.salesPersonId).not.toBe(other.id);
  });

  it("is idempotent (second run is a no-op)", async () => {
    const staff = await prisma.staffMember.create({
      data: { displayName: "Idempotent", role: "DESIGNER" },
    });
    await prisma.salesOrder.create({
      data: {
        orderno: "SO-IDEMPOTENT",
        salesperson: "Idempotent",
        salesPersonId: null,
      },
    });

    const first = await backfillSalesPersonFk(prisma);
    const second = await backfillSalesPersonFk(prisma);

    expect(first.updated).toBe(1);
    expect(second.updated).toBe(0);
    void staff;
  });

  it("skips orders with empty / NULL salesperson", async () => {
    await prisma.staffMember.create({
      data: { displayName: "Anyone", role: "DESIGNER" },
    });
    await prisma.salesOrder.create({
      data: { orderno: "SO-EMPTY-STR", salesperson: "", salesPersonId: null },
    });
    await prisma.salesOrder.create({
      data: { orderno: "SO-NULL-STR", salesperson: null, salesPersonId: null },
    });

    const result = await backfillSalesPersonFk(prisma);

    expect(result.updated).toBe(0);
  });
});
