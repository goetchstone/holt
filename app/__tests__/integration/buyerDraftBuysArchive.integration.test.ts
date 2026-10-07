// /app/__tests__/integration/buyerDraftBuysArchive.integration.test.ts
//
// 2026-05-13 — B-grade integration coverage for the buys-archive
// rollup. Tests against real Prisma to confirm:
//
//   1. Only `status = CLOSED` buys appear (active buys hidden).
//   2. `spent` rolls up `Σ qty × cost` across every item nested under
//      every PO of the Buy.
//   3. `poCount` / `itemCount` from `_count` projections are accurate.
//   4. Ordering is `year DESC, updated DESC` so the most-recently-
//      closed buys land first.
//
// Why real-DB: the handler does the rollup math inline on Prisma's
// nested-include result. Mocked-Prisma tests would let the JS math
// pass while the underlying join behavior silently changed.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";

// Re-implementing the rollup math inline so the test asserts on the
// exact response shape the API emits. The handler isn't directly
// callable from integration tests (it requires the requireAuthWithRole
// wrapper); replicating the logic against the same Prisma query is the
// pragmatic shape per CLAUDE.md rule 14.

async function loadArchive() {
  const rows = await prisma.buyerDraftBuy.findMany({
    where: { status: "CLOSED" },
    select: {
      id: true,
      name: true,
      season: true,
      year: true,
      status: true,
      budget: true,
      kickoff: true,
      updated: true,
      pos: {
        select: {
          items: { select: { qty: true, cost: true } },
          _count: { select: { items: true } },
        },
      },
      _count: { select: { pos: true } },
    },
    orderBy: [{ year: "desc" }, { updated: "desc" }],
  });
  return rows.map((b) => {
    let spent = 0;
    let itemCount = 0;
    for (const po of b.pos) {
      itemCount += po._count.items;
      for (const it of po.items) {
        spent += Number(it.qty) * Number(it.cost.toString());
      }
    }
    return {
      id: b.id,
      name: b.name,
      year: b.year,
      spent: Math.round(spent * 100) / 100,
      poCount: b._count.pos,
      itemCount,
    };
  });
}

describe("buyer-drafts archive — buys rollup (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("returns only CLOSED buys; active ones (PLANNING / OPEN / EXPORTED) are hidden", async () => {
    await prisma.buyerDraftBuy.createMany({
      data: [
        { name: "Spring 2026", status: "PLANNING", year: 2026 },
        { name: "Fall 2025", status: "CLOSED", year: 2025 },
        { name: "Holiday 2024", status: "CLOSED", year: 2024 },
        { name: "Summer 2025 in-flight", status: "EXPORTED", year: 2025 },
        { name: "Winter 2024 open", status: "OPEN", year: 2024 },
      ],
    });
    const archive = await loadArchive();
    expect(archive.map((b) => b.name)).toEqual(["Fall 2025", "Holiday 2024"]);
  });

  it("rolls up spent = Σ qty × cost across every item in every PO", async () => {
    const buy = await prisma.buyerDraftBuy.create({
      data: { name: "Buy A", status: "CLOSED", year: 2024 },
    });
    const po1 = await prisma.buyerDraftPurchaseOrder.create({
      data: { vendorName: "AL", buyId: buy.id },
    });
    const po2 = await prisma.buyerDraftPurchaseOrder.create({
      data: { vendorName: "BY", buyId: buy.id },
    });
    // Buy A: 2 × $1000 + 1 × $500 + 3 × $250 = $2000 + $500 + $750 = $3250
    await prisma.buyerDraftItem.createMany({
      data: [
        {
          partNumber: "P1",
          productName: "Item 1",
          qty: 2,
          cost: new Prisma.Decimal(1000),
          retail: new Prisma.Decimal(2500),
          vendorName: "AL",
          draftPoId: po1.id,
        },
        {
          partNumber: "P2",
          productName: "Item 2",
          qty: 1,
          cost: new Prisma.Decimal(500),
          retail: new Prisma.Decimal(1100),
          vendorName: "AL",
          draftPoId: po1.id,
        },
        {
          partNumber: "P3",
          productName: "Item 3",
          qty: 3,
          cost: new Prisma.Decimal(250),
          retail: new Prisma.Decimal(600),
          vendorName: "BY",
          draftPoId: po2.id,
        },
      ],
    });

    const archive = await loadArchive();
    expect(archive).toHaveLength(1);
    expect(archive[0].spent).toBe(3250);
    expect(archive[0].poCount).toBe(2);
    expect(archive[0].itemCount).toBe(3);
  });

  it("handles a closed Buy with no POs (spent = 0, poCount = 0, itemCount = 0)", async () => {
    await prisma.buyerDraftBuy.create({
      data: { name: "Empty Closed", status: "CLOSED", year: 2024 },
    });
    const archive = await loadArchive();
    expect(archive).toHaveLength(1);
    expect(archive[0].spent).toBe(0);
    expect(archive[0].poCount).toBe(0);
    expect(archive[0].itemCount).toBe(0);
  });

  it("orders by year DESC then by updated DESC (most-recently-closed first)", async () => {
    // Three buys: two from the same year, one older. The two same-
    // year buys should sort by updated; the older year should land
    // after both.
    const old1 = await prisma.buyerDraftBuy.create({
      data: { name: "Old", status: "CLOSED", year: 2023 },
    });
    const recent1 = await prisma.buyerDraftBuy.create({
      data: { name: "Recent1", status: "CLOSED", year: 2025 },
    });
    const recent2 = await prisma.buyerDraftBuy.create({
      data: { name: "Recent2", status: "CLOSED", year: 2025 },
    });
    // Force updated timestamps so the ordering is deterministic.
    await prisma.buyerDraftBuy.update({
      where: { id: recent1.id },
      data: { updated: new Date("2025-01-15") },
    });
    await prisma.buyerDraftBuy.update({
      where: { id: recent2.id },
      data: { updated: new Date("2025-06-20") },
    });
    await prisma.buyerDraftBuy.update({
      where: { id: old1.id },
      data: { updated: new Date("2023-08-01") },
    });

    const archive = await loadArchive();
    expect(archive.map((b) => b.name)).toEqual(["Recent2", "Recent1", "Old"]);
  });
});
