// /app/__tests__/integration/buyerDraftLinkedPos.integration.test.ts
//
// B-grade integration coverage for the buyer-draft → real-PO link
// query. Real Postgres, real schema, real Prisma — proves the actual
// SQL behavior of the API endpoint's hydration step.
//
// Mirrors the Spring 2026 / Bradington Young case that surfaced
// 2026-05-14: one draft PO (3 items) maps to three real PONs because
// the buyer combined three real the POS POs into one draft for
// planning convenience.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import {
  computeLinkedPos,
  type DraftItemInput,
  type DraftPoInput,
  type RealPoInput,
  type RealPoLineInput,
} from "@/lib/buyerDraftRealPoLink";

// Replays the API endpoint's hydration step against real Prisma, then
// hands the inputs to `computeLinkedPos`. The handler itself isn't
// directly callable from integration tests (requireAuthWithRole), so
// per CLAUDE.md rule 14 we lift the SAME Prisma queries here and
// assert on the same engine output the handler returns.
async function loadLinkedPos(buyId: number) {
  const draftRows = await prisma.buyerDraftItem.findMany({
    where: { draftPo: { buyId } },
    select: {
      id: true,
      partNumber: true,
      productName: true,
      vendorName: true,
      fulfilledProductId: true,
      draftPoId: true,
    },
  });
  const draftPoRows = await prisma.buyerDraftPurchaseOrder.findMany({
    where: { buyId },
    select: { id: true, vendorName: true },
  });
  const linkedProductIds = draftRows
    .map((d) => d.fulfilledProductId)
    .filter((v): v is number => v !== null);
  let realPoLines: RealPoLineInput[] = [];
  let realPos: RealPoInput[] = [];
  if (linkedProductIds.length > 0) {
    const matchingLines = await prisma.purchaseOrderItem.findMany({
      where: { productId: { in: linkedProductIds } },
      select: { purchaseOrderId: true },
    });
    const realPoIds = [...new Set(matchingLines.map((l) => l.purchaseOrderId))];
    if (realPoIds.length > 0) {
      const [allLines, realPoRows] = await Promise.all([
        prisma.purchaseOrderItem.findMany({
          where: { purchaseOrderId: { in: realPoIds } },
          select: { purchaseOrderId: true, productId: true, orderedQuantity: true },
        }),
        prisma.purchaseOrder.findMany({
          where: { id: { in: realPoIds } },
          select: {
            id: true,
            poNumber: true,
            status: true,
            orderDate: true,
            vendor: { select: { id: true, name: true } },
          },
        }),
      ]);
      realPoLines = allLines.map((l) => ({
        realPoId: l.purchaseOrderId,
        productId: l.productId,
        orderedQuantity: l.orderedQuantity == null ? 0 : Number(l.orderedQuantity.toString()),
      }));
      realPos = realPoRows.map((p) => ({
        id: p.id,
        poNumber: p.poNumber,
        vendor: p.vendor?.name ?? "(unknown)",
        vendorId: p.vendor?.id ?? null,
        orderDate: p.orderDate,
        status: p.status,
      }));
    }
  }
  const drafts: DraftItemInput[] = draftRows.map((d) => ({
    id: d.id,
    partNumber: d.partNumber,
    productName: d.productName,
    vendorName: d.vendorName,
    fulfilledProductId: d.fulfilledProductId,
    draftPoId: d.draftPoId,
  }));
  const draftPos: DraftPoInput[] = draftPoRows.map((p) => ({
    id: p.id,
    vendorName: p.vendorName,
  }));
  return computeLinkedPos(drafts, draftPos, realPos, realPoLines);
}

describe("buyer-drafts linked-POs query (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("finds the 1:N draft → real POs mapping (Bradington Young pattern)", async () => {
    // Set up the fixture: 1 buy, 1 draft PO with 3 items each linked
    // to a distinct Product, each Product on its own real PO.
    const vendor = await prisma.vendor.create({
      data: { name: "Bradington Young", code: "BY" },
    });
    const dept = await prisma.department.create({ data: { name: "Furniture" } });
    const cat = await prisma.category.create({
      data: { name: "Seating", departmentId: dept.id },
    });
    const p1 = await prisma.product.create({
      data: {
        productNumber: "BRAD-3033",
        name: "Kipton",
        vendorId: vendor.id,
        departmentId: dept.id,
        categoryId: cat.id,
      },
    });
    const p2 = await prisma.product.create({
      data: {
        productNumber: "BRAD-4114",
        name: "Chippendale",
        vendorId: vendor.id,
        departmentId: dept.id,
        categoryId: cat.id,
      },
    });
    const p3 = await prisma.product.create({
      data: {
        productNumber: "BRAD-8010",
        name: "Ryder",
        vendorId: vendor.id,
        departmentId: dept.id,
        categoryId: cat.id,
      },
    });

    const buy = await prisma.buyerDraftBuy.create({
      data: { name: "Spring 2026", status: "PLANNING", year: 2026 },
    });
    const draftPo = await prisma.buyerDraftPurchaseOrder.create({
      data: { vendorName: "Bradington Young", buyId: buy.id, vendorId: vendor.id },
    });
    await prisma.buyerDraftItem.createMany({
      data: [
        {
          partNumber: "BRAD-3033",
          productName: "Kipton",
          vendorName: "Bradington Young",
          vendorId: vendor.id,
          qty: 1,
          cost: new Prisma.Decimal(500),
          retail: new Prisma.Decimal(1500),
          draftPoId: draftPo.id,
          fulfilledProductId: p1.id,
        },
        {
          partNumber: "BRAD-4114",
          productName: "Chippendale",
          vendorName: "Bradington Young",
          vendorId: vendor.id,
          qty: 1,
          cost: new Prisma.Decimal(700),
          retail: new Prisma.Decimal(2100),
          draftPoId: draftPo.id,
          fulfilledProductId: p2.id,
        },
        {
          partNumber: "BRAD-8010",
          productName: "Ryder",
          vendorName: "Bradington Young",
          vendorId: vendor.id,
          qty: 1,
          cost: new Prisma.Decimal(600),
          retail: new Prisma.Decimal(1800),
          draftPoId: draftPo.id,
          fulfilledProductId: p3.id,
        },
      ],
    });

    // Three real POs, one item each.
    const po1 = await prisma.purchaseOrder.create({
      data: {
        poNumber: "PON07054",
        vendorId: vendor.id,
        orderDate: new Date("2025-10-21"),
        status: "RECEIVED_FULL",
      },
    });
    const po2 = await prisma.purchaseOrder.create({
      data: {
        poNumber: "PON07576",
        vendorId: vendor.id,
        orderDate: new Date("2025-12-16"),
        status: "RECEIVED_FULL",
      },
    });
    const po3 = await prisma.purchaseOrder.create({
      data: {
        poNumber: "PON08313",
        vendorId: vendor.id,
        orderDate: new Date("2026-03-27"),
        status: "CONFIRMED",
      },
    });
    await prisma.purchaseOrderItem.createMany({
      data: [
        {
          purchaseOrderId: po1.id,
          productId: p1.id,
          partNo: "BRAD-3033",
          orderedQuantity: 1,
          unitCost: new Prisma.Decimal(500),
        },
        {
          purchaseOrderId: po2.id,
          productId: p2.id,
          partNo: "BRAD-4114",
          orderedQuantity: 1,
          unitCost: new Prisma.Decimal(700),
        },
        {
          purchaseOrderId: po3.id,
          productId: p3.id,
          partNo: "BRAD-8010",
          orderedQuantity: 1,
          unitCost: new Prisma.Decimal(600),
        },
      ],
    });

    const result = await loadLinkedPos(buy.id);
    expect(result.totals).toMatchObject({
      draftItems: 3,
      draftItemsLinked: 3,
      draftPos: 1,
      matchedRealPos: 3,
      unmatchedDraftItems: 0,
    });
    expect(result.realPos.map((p) => p.poNumber)).toEqual(["PON07054", "PON07576", "PON08313"]);
    expect(result.draftPos[0].linkedRealPoNumbers).toEqual(["PON07054", "PON07576", "PON08313"]);
  });

  it("surfaces drafts with no fulfilledProductId as `no-link`", async () => {
    const vendor = await prisma.vendor.create({
      data: { name: "Wesley Hall", code: "WH" },
    });
    const buy = await prisma.buyerDraftBuy.create({
      data: { name: "Spring 2026", status: "PLANNING", year: 2026 },
    });
    const draftPo = await prisma.buyerDraftPurchaseOrder.create({
      data: { vendorName: "Wesley Hall", buyId: buy.id, vendorId: vendor.id },
    });
    await prisma.buyerDraftItem.create({
      data: {
        partNumber: "NEW-FRAME",
        productName: "Net-new item, no catalog row yet",
        vendorName: "Wesley Hall",
        vendorId: vendor.id,
        qty: 1,
        cost: new Prisma.Decimal(1000),
        retail: new Prisma.Decimal(3000),
        draftPoId: draftPo.id,
        fulfilledProductId: null,
      },
    });

    const result = await loadLinkedPos(buy.id);
    expect(result.totals).toMatchObject({
      draftItems: 1,
      draftItemsLinked: 0,
      matchedRealPos: 0,
      unmatchedDraftItems: 1,
    });
    expect(result.unmatchedDrafts[0]).toMatchObject({
      partNumber: "NEW-FRAME",
      reason: "no-link",
    });
  });

  it("reports partial real-PO coverage (real PO has extra lines)", async () => {
    const vendor = await prisma.vendor.create({
      data: { name: "C R Laine Furniture", code: "CRL" },
    });
    const dept = await prisma.department.create({ data: { name: "Furniture" } });
    const cat = await prisma.category.create({
      data: { name: "Seating", departmentId: dept.id },
    });
    const drafted = await prisma.product.create({
      data: {
        productNumber: "CRL-A",
        name: "Drafted",
        vendorId: vendor.id,
        departmentId: dept.id,
        categoryId: cat.id,
      },
    });
    const extra1 = await prisma.product.create({
      data: {
        productNumber: "CRL-B",
        name: "Extra 1",
        vendorId: vendor.id,
        departmentId: dept.id,
        categoryId: cat.id,
      },
    });
    const extra2 = await prisma.product.create({
      data: {
        productNumber: "CRL-C",
        name: "Extra 2",
        vendorId: vendor.id,
        departmentId: dept.id,
        categoryId: cat.id,
      },
    });

    const buy = await prisma.buyerDraftBuy.create({
      data: { name: "Spring 2026", status: "PLANNING", year: 2026 },
    });
    const draftPo = await prisma.buyerDraftPurchaseOrder.create({
      data: { vendorName: "C R Laine Furniture", buyId: buy.id, vendorId: vendor.id },
    });
    await prisma.buyerDraftItem.create({
      data: {
        partNumber: "CRL-A",
        productName: "Drafted",
        vendorName: "C R Laine Furniture",
        vendorId: vendor.id,
        qty: 2,
        cost: new Prisma.Decimal(500),
        retail: new Prisma.Decimal(1500),
        draftPoId: draftPo.id,
        fulfilledProductId: drafted.id,
      },
    });

    const realPo = await prisma.purchaseOrder.create({
      data: {
        poNumber: "PON07817",
        vendorId: vendor.id,
        orderDate: new Date("2026-01-26"),
        status: "RECEIVED_FULL",
      },
    });
    await prisma.purchaseOrderItem.createMany({
      data: [
        {
          purchaseOrderId: realPo.id,
          productId: drafted.id,
          partNo: "CRL-A",
          orderedQuantity: 2,
          unitCost: new Prisma.Decimal(500),
        },
        {
          purchaseOrderId: realPo.id,
          productId: extra1.id,
          partNo: "CRL-B",
          orderedQuantity: 1,
          unitCost: new Prisma.Decimal(600),
        },
        {
          purchaseOrderId: realPo.id,
          productId: extra2.id,
          partNo: "CRL-C",
          orderedQuantity: 1,
          unitCost: new Prisma.Decimal(700),
        },
      ],
    });

    const result = await loadLinkedPos(buy.id);
    expect(result.realPos[0]).toMatchObject({
      poNumber: "PON07817",
      matchedLines: 1,
      totalLines: 3,
      matchedQty: 2,
      totalQty: 4,
    });
  });

  it("only includes drafts attached to this Buy (other-buy items ignored)", async () => {
    const vendor = await prisma.vendor.create({
      data: { name: "Test Vendor", code: "T" },
    });
    const dept = await prisma.department.create({ data: { name: "Furniture" } });
    const cat = await prisma.category.create({
      data: { name: "Seating", departmentId: dept.id },
    });
    const productA = await prisma.product.create({
      data: {
        productNumber: "A",
        name: "A",
        vendorId: vendor.id,
        departmentId: dept.id,
        categoryId: cat.id,
      },
    });
    const productB = await prisma.product.create({
      data: {
        productNumber: "B",
        name: "B",
        vendorId: vendor.id,
        departmentId: dept.id,
        categoryId: cat.id,
      },
    });

    const buyA = await prisma.buyerDraftBuy.create({
      data: { name: "Buy A", status: "PLANNING", year: 2026 },
    });
    const buyB = await prisma.buyerDraftBuy.create({
      data: { name: "Buy B", status: "PLANNING", year: 2026 },
    });
    const poA = await prisma.buyerDraftPurchaseOrder.create({
      data: { vendorName: "Test Vendor", buyId: buyA.id, vendorId: vendor.id },
    });
    const poB = await prisma.buyerDraftPurchaseOrder.create({
      data: { vendorName: "Test Vendor", buyId: buyB.id, vendorId: vendor.id },
    });
    await prisma.buyerDraftItem.createMany({
      data: [
        {
          partNumber: "A",
          productName: "A",
          vendorName: "Test Vendor",
          vendorId: vendor.id,
          qty: 1,
          cost: new Prisma.Decimal(100),
          retail: new Prisma.Decimal(200),
          draftPoId: poA.id,
          fulfilledProductId: productA.id,
        },
        {
          partNumber: "B",
          productName: "B",
          vendorName: "Test Vendor",
          vendorId: vendor.id,
          qty: 1,
          cost: new Prisma.Decimal(100),
          retail: new Prisma.Decimal(200),
          draftPoId: poB.id,
          fulfilledProductId: productB.id,
        },
      ],
    });

    const realPo = await prisma.purchaseOrder.create({
      data: { poNumber: "PON-A", vendorId: vendor.id, status: "RECEIVED_FULL" },
    });
    await prisma.purchaseOrderItem.create({
      data: {
        purchaseOrderId: realPo.id,
        productId: productA.id,
        partNo: "A",
        orderedQuantity: 1,
        unitCost: new Prisma.Decimal(100),
      },
    });

    const resultA = await loadLinkedPos(buyA.id);
    const resultB = await loadLinkedPos(buyB.id);

    expect(resultA.totals.draftItems).toBe(1);
    expect(resultA.totals.matchedRealPos).toBe(1);
    expect(resultB.totals.draftItems).toBe(1);
    expect(resultB.totals.matchedRealPos).toBe(0);
    expect(resultB.unmatchedDrafts[0]).toMatchObject({
      partNumber: "B",
      reason: "not-on-any-real-po",
    });
  });
});
