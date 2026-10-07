// /app/__tests__/integration/historicalPoImport.integration.test.ts
//
// Slice 6.13 (2026-05-22) — Real-DB integration test for the historical
// PurchaseOrder → BuyerDraftPurchaseOrder + BuyerDraftItem import.
//
// Mirrors the buyerDraftAutoLink.integration.test.ts shape (per the
// buyer-drafts runbook): create fixtures via Prisma, run the helper +
// the create chain directly, assert downstream rows. The API handler
// itself is thin (auth wrapper + transaction); the create/upsert SQL
// shape is what this test exercises.

import { resetTestDb } from "@/lib/testing/withTestDb";
import { prisma } from "@/lib/prisma";
import { buildImportFromPurchaseOrder } from "@/lib/historicalPoImport";

describe("historicalPoImport — real DB", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("creates draft PO + items with fulfilledProductId set and importedFromPurchaseOrderId unique", async () => {
    // ── Fixtures ─────────────────────────────────────────────────────
    const vendor = await prisma.vendor.create({ data: { name: "Wesley Hall" } });
    const dept = await prisma.department.create({ data: { name: "Living Room" } });
    const cat = await prisma.category.create({
      data: { name: "Sofas", departmentId: dept.id },
    });
    const productA = await prisma.product.create({
      data: {
        productNumber: "WH-1001",
        name: "Sofa 90in, Calvin Sky",
        vendorId: vendor.id,
        departmentId: dept.id,
        categoryId: cat.id,
        baseCost: "1800.00",
        baseRetail: "4500.00",
      },
    });
    const productB = await prisma.product.create({
      data: {
        productNumber: "WH-1002",
        name: "Chair, Calvin Sky",
        vendorId: vendor.id,
        departmentId: dept.id,
        categoryId: cat.id,
        baseCost: "950.00",
        baseRetail: "2400.00",
      },
    });

    const po = await prisma.purchaseOrder.create({
      data: {
        poNumber: "PON12345",
        vendorId: vendor.id,
        orderDate: new Date(Date.UTC(2025, 9, 15)),
        expectedDelivery: new Date(Date.UTC(2026, 2, 1)),
        estimatedShipDate: new Date(Date.UTC(2026, 1, 15)),
        status: "RECEIVED_FULL",
        lineItems: {
          create: [
            {
              productId: productA.id,
              orderedQuantity: 2,
              unitCost: "1800.00",
              partNo: "WH-1001",
              productName: "Sofa 90in, Calvin Sky",
            },
            {
              productId: productB.id,
              orderedQuantity: 4,
              unitCost: "950.00",
              partNo: "WH-1002",
              productName: "Chair, Calvin Sky",
            },
            // Unlinked line — should be skipped
            {
              productId: null,
              orderedQuantity: 1,
              unitCost: "100.00",
              partNo: "MYSTERY-9",
              productName: "Unknown SKU",
            },
          ],
        },
      },
    });

    const buy = await prisma.buyerDraftBuy.create({
      data: { name: "Spring 2026", season: "Spring", year: 2026 },
    });

    // ── Hydrate the same shape the handler does ──────────────────────
    const hydrated = await prisma.purchaseOrder.findUnique({
      where: { id: po.id },
      select: {
        id: true,
        poNumber: true,
        vendorId: true,
        vendor: { select: { name: true } },
        orderDate: true,
        expectedDelivery: true,
        estimatedShipDate: true,
        status: true,
        notes: true,
        lineItems: {
          select: {
            id: true,
            productId: true,
            orderedQuantity: true,
            unitCost: true,
            partNo: true,
            productName: true,
            product: {
              select: { id: true, productNumber: true, name: true, baseRetail: true },
            },
          },
        },
      },
    });
    expect(hydrated).not.toBeNull();
    if (!hydrated) return;

    // ── Run the helper + replay the handler's transaction ────────────
    const built = buildImportFromPurchaseOrder(hydrated);
    expect(built.draftItems).toHaveLength(2);
    expect(built.skipped).toHaveLength(1);

    const createdDraftPo = await prisma.buyerDraftPurchaseOrder.create({
      data: { ...built.draftPo, buyId: buy.id },
      select: { id: true },
    });
    await prisma.buyerDraftItem.createMany({
      data: built.draftItems.map((item) => ({ ...item, draftPoId: createdDraftPo.id })),
    });

    // Also create the join row (Slice 6.14 — handler does this in
    // the same transaction; the test follows the handler shape).
    await prisma.buyerDraftPoRealPoLink.create({
      data: {
        draftPoId: createdDraftPo.id,
        realPoId: built.realPoIdForLink,
        linkSource: "HISTORICAL_IMPORT",
      },
    });

    // ── Assertions ───────────────────────────────────────────────────
    const draftPoRow = await prisma.buyerDraftPurchaseOrder.findUnique({
      where: { id: createdDraftPo.id },
      include: {
        items: { orderBy: { partNumber: "asc" } },
        realPoLinks: true,
      },
    });
    expect(draftPoRow).not.toBeNull();
    if (!draftPoRow) return;
    expect(draftPoRow.realPoLinks).toHaveLength(1);
    expect(draftPoRow.realPoLinks[0].realPoId).toBe(po.id);
    expect(draftPoRow.realPoLinks[0].linkSource).toBe("HISTORICAL_IMPORT");
    expect(draftPoRow.buyId).toBe(buy.id);
    expect(draftPoRow.status).toBe("FULFILLED");
    expect(draftPoRow.referenceNumber).toBe("PON12345");
    expect(draftPoRow.items).toHaveLength(2);
    expect(draftPoRow.items.map((it) => it.fulfilledProductId).sort()).toEqual(
      [productA.id, productB.id].sort(),
    );
    expect(draftPoRow.items.every((it) => it.source === "HISTORICAL_PO_IMPORT")).toBe(true);
    expect(draftPoRow.items.every((it) => it.status === "FULFILLED")).toBe(true);
  });

  it("blocks a second import of the same PO via the @unique realPoId constraint", async () => {
    // ── Minimal fixtures ─────────────────────────────────────────────
    const vendor = await prisma.vendor.create({ data: { name: "CR Laine" } });
    const dept = await prisma.department.create({ data: { name: "Living Room" } });
    const cat = await prisma.category.create({
      data: { name: "Sofas", departmentId: dept.id },
    });
    const product = await prisma.product.create({
      data: {
        productNumber: "CRL-9000",
        name: "Loveseat",
        vendorId: vendor.id,
        departmentId: dept.id,
        categoryId: cat.id,
        baseCost: "1200.00",
        baseRetail: "3000.00",
      },
    });
    const po = await prisma.purchaseOrder.create({
      data: {
        poNumber: "PON55555",
        vendorId: vendor.id,
        orderDate: new Date(Date.UTC(2025, 8, 10)),
        status: "RECEIVED_FULL",
        lineItems: {
          create: [
            { productId: product.id, orderedQuantity: 1, unitCost: "1200.00", partNo: "CRL-9000" },
          ],
        },
      },
    });
    const buy = await prisma.buyerDraftBuy.create({ data: { name: "Fall 2025" } });

    // First import: create draft PO + link
    const firstDraftPo = await prisma.buyerDraftPurchaseOrder.create({
      data: {
        vendorId: vendor.id,
        vendorName: "CR Laine",
        referenceNumber: "PON55555",
        status: "FULFILLED",
        buyId: buy.id,
      },
    });
    await prisma.buyerDraftPoRealPoLink.create({
      data: {
        draftPoId: firstDraftPo.id,
        realPoId: po.id,
        linkSource: "HISTORICAL_IMPORT",
      },
    });

    // Second import attempt: create another draft PO + try to link the
    // same real PO. Must violate the unique constraint on realPoId.
    const secondDraftPo = await prisma.buyerDraftPurchaseOrder.create({
      data: {
        vendorId: vendor.id,
        vendorName: "CR Laine",
        referenceNumber: "PON55555-dup",
        status: "FULFILLED",
        buyId: buy.id,
      },
    });
    await expect(
      prisma.buyerDraftPoRealPoLink.create({
        data: {
          draftPoId: secondDraftPo.id,
          realPoId: po.id,
          linkSource: "HISTORICAL_IMPORT",
        },
      }),
    ).rejects.toThrow();
  });

  it("looks up the existing link via the unique realPoId (idempotency check pattern)", async () => {
    const vendor = await prisma.vendor.create({ data: { name: "Kingsley Bate" } });
    const po = await prisma.purchaseOrder.create({
      data: {
        poNumber: "PON77777",
        vendorId: vendor.id,
        orderDate: new Date(Date.UTC(2025, 5, 1)),
        status: "RECEIVED_FULL",
      },
    });
    const buy = await prisma.buyerDraftBuy.create({ data: { name: "Outdoor 2025" } });

    const draftPo = await prisma.buyerDraftPurchaseOrder.create({
      data: {
        vendorId: vendor.id,
        vendorName: "Kingsley Bate",
        referenceNumber: "PON77777",
        status: "FULFILLED",
        buyId: buy.id,
      },
    });
    await prisma.buyerDraftPoRealPoLink.create({
      data: {
        draftPoId: draftPo.id,
        realPoId: po.id,
        linkSource: "HISTORICAL_IMPORT",
      },
    });

    const existing = await prisma.buyerDraftPoRealPoLink.findUnique({
      where: { realPoId: po.id },
      select: { draftPo: { select: { id: true, buyId: true, buy: { select: { name: true } } } } },
    });
    expect(existing).not.toBeNull();
    expect(existing?.draftPo.buy?.name).toBe("Outdoor 2025");
  });
});
