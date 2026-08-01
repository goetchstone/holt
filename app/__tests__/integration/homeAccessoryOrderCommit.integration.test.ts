// /app/__tests__/integration/homeAccessoryOrderCommit.integration.test.ts
//
// Real-DB integration test for the Home Accessory Order Import commit
// flow: composed EffectiveRows -> homeAccessoryBuyerDraftMapping.ts ->
// buildPoCreateData / buildItemCreateData (lib/buyerDraftRequestBody.ts) ->
// actual BuyerDraftPurchaseOrder + BuyerDraftItem rows written via Prisma.
// Mirrors the historicalPoImport.integration.test.ts shape (per the
// buyer-drafts runbook): create fixtures via Prisma, run the mapping +
// create chain directly (the API handler itself is a thin auth wrapper +
// transaction around exactly this), assert the resulting rows. This is
// the "does it actually write to Postgres correctly" check the pure unit
// tests in homeAccessoryBuyerDraftMapping.test.ts can't cover (Decimal
// coercion, enum acceptance, FK scalar writes).

import { resetTestDb } from "@/lib/testing/withTestDb";
import { prisma } from "@/lib/prisma";
import { buildItemCreateData, buildPoCreateData } from "@/lib/buyerDraftRequestBody";
import {
  buildHomeAccessoryItemCreateBody,
  buildHomeAccessoryPoCreateBody,
  groupRowsByReference,
  unassignedRows,
  type HomeAccessoryCommitContext,
} from "@/lib/homeAccessoryBuyerDraftMapping";
import type { EffectiveRow } from "@/lib/homeAccessoryRows";

function effectiveRow(overrides: Partial<EffectiveRow> = {}): EffectiveRow {
  return {
    key: "0",
    rowIndex: 0,
    setSize: null,
    isSplitChild: false,
    poExcluded: false,
    departmentId: null,
    categoryId: null,
    partNumber: "KKI-15668B",
    styleNumber: "15668B",
    productName: "13.5 Inch Brown Resin Horse",
    color: "",
    size: "",
    qty: 4,
    cost: 39.99,
    msrp: null,
    selling: null,
    department: "",
    category: "",
    supplier: "K & K Interiors",
    barcode: "842657186221",
    reference: "0002592360",
    ...overrides,
  };
}

/** Mirrors the commit API route's transaction body exactly (pages/api/
 *  tools/home-accessory-order/commit.ts) so this test exercises the real
 *  create chain rather than a re-implementation. */
async function commitRows(rows: EffectiveRow[], ctx: HomeAccessoryCommitContext) {
  const groups = groupRowsByReference(rows);
  const unassigned = unassignedRows(rows);
  return prisma.$transaction(async (tx) => {
    const createdPos: { id: number; referenceNumber: string | null }[] = [];
    let itemsCreated = 0;

    for (const group of groups) {
      const poData = buildPoCreateData(buildHomeAccessoryPoCreateBody(group, ctx), "test-user");
      const po = await tx.buyerDraftPurchaseOrder.create({ data: poData });
      createdPos.push({ id: po.id, referenceNumber: po.referenceNumber });
      for (const row of group.rows) {
        const itemData = buildItemCreateData(
          buildHomeAccessoryItemCreateBody(row, po.id, ctx),
          "test-user",
        );
        await tx.buyerDraftItem.create({ data: itemData });
        itemsCreated++;
      }
    }
    for (const row of unassigned) {
      const itemData = buildItemCreateData(
        buildHomeAccessoryItemCreateBody(row, null, ctx),
        "test-user",
      );
      await tx.buyerDraftItem.create({ data: itemData });
      itemsCreated++;
    }
    return { createdPos, itemsCreated };
  });
}

describe("Home Accessory Order Import commit — real DB", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("creates one BuyerDraftPurchaseOrder + BuyerDraftItems for a single-order document", async () => {
    const vendor = await prisma.vendor.create({ data: { name: "K & K Interiors", code: "KKI" } });
    const dept = await prisma.department.create({ data: { name: "Home Acc" } });
    const cat = await prisma.category.create({ data: { name: "Decor", departmentId: dept.id } });

    const ctx: HomeAccessoryCommitContext = {
      vendorId: vendor.id,
      vendorName: vendor.name,
      stockLocationId: null,
      buyId: null,
      sourceLabel: "Home Accessory Order Import — K & K Interiors",
    };
    const rows = [effectiveRow({ departmentId: dept.id, categoryId: cat.id })];

    const result = await commitRows(rows, ctx);

    expect(result.createdPos).toHaveLength(1);
    expect(result.itemsCreated).toBe(1);

    const po = await prisma.buyerDraftPurchaseOrder.findUniqueOrThrow({
      where: { id: result.createdPos[0].id },
    });
    expect(po.vendorId).toBe(vendor.id);
    expect(po.referenceNumber).toBe("0002592360");
    expect(po.status).toBe("DRAFT");

    const items = await prisma.buyerDraftItem.findMany({ where: { draftPoId: po.id } });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      partNumber: "KKI-15668B",
      productName: "13.5 Inch Brown Resin Horse",
      qty: 4,
      barcode: "842657186221",
      source: "HOME_ACCESSORY_ORDER_IMPORT",
      itemType: "OTHER",
      departmentId: dept.id,
      categoryId: cat.id,
    });
    expect(items[0].cost.toNumber()).toBe(39.99);
    // No selling/msrp typed -> retail falls back to cost (never left blank
    // on the required, non-nullable column).
    expect(items[0].retail.toNumber()).toBe(39.99);
    expect(items[0].msrp).toBeNull();
  });

  it("a multi-order bundle creates MULTIPLE draft POs, not one merged PO", async () => {
    const vendor = await prisma.vendor.create({ data: { name: "K & K Interiors", code: "KKI" } });
    const ctx: HomeAccessoryCommitContext = {
      vendorId: vendor.id,
      vendorName: vendor.name,
      stockLocationId: null,
      buyId: null,
      sourceLabel: "Home Accessory Order Import — K & K Interiors",
    };
    const rows = [
      effectiveRow({ key: "0", partNumber: "KKI-AAA", reference: "0002592360" }),
      effectiveRow({ key: "1", partNumber: "KKI-BBB", reference: "0002592361" }),
    ];

    const result = await commitRows(rows, ctx);

    expect(result.createdPos).toHaveLength(2);
    expect(result.itemsCreated).toBe(2);

    const pos = await prisma.buyerDraftPurchaseOrder.findMany({
      orderBy: { referenceNumber: "asc" },
    });
    expect(pos.map((p) => p.referenceNumber)).toEqual(["0002592360", "0002592361"]);

    // Each item lands on ITS OWN order's PO, not both on one.
    for (const po of pos) {
      const items = await prisma.buyerDraftItem.findMany({ where: { draftPoId: po.id } });
      expect(items).toHaveLength(1);
    }
  });

  it("a split set's pieces all land on the same draft PO with distinct part numbers + suffixed barcodes", async () => {
    const vendor = await prisma.vendor.create({ data: { name: "K & K Interiors", code: "KKI" } });
    const ctx: HomeAccessoryCommitContext = {
      vendorId: vendor.id,
      vendorName: vendor.name,
      stockLocationId: null,
      buyId: null,
      sourceLabel: "Home Accessory Order Import — K & K Interiors",
    };
    const rows = [
      effectiveRow({
        key: "0:0",
        rowIndex: 0,
        isSplitChild: true,
        partNumber: "KKI-17695A-LG",
        productName: "Dark Mango Wood Candleholders Large",
        cost: 25.64,
        barcode: "840220407476-1",
      }),
      effectiveRow({
        key: "0:1",
        rowIndex: 0,
        isSplitChild: true,
        partNumber: "KKI-17695A-MD",
        productName: "Dark Mango Wood Candleholders Medium",
        cost: 18.81,
        barcode: "840220407476-2",
      }),
      effectiveRow({
        key: "0:2",
        rowIndex: 0,
        isSplitChild: true,
        partNumber: "KKI-17695A-SM",
        productName: "Dark Mango Wood Candleholders Small",
        cost: 12.54,
        barcode: "840220407476-3",
      }),
    ];

    const result = await commitRows(rows, ctx);
    expect(result.createdPos).toHaveLength(1);
    expect(result.itemsCreated).toBe(3);

    const items = await prisma.buyerDraftItem.findMany({
      where: { draftPoId: result.createdPos[0].id },
      orderBy: { partNumber: "asc" },
    });
    expect(items.map((i) => i.partNumber)).toEqual([
      "KKI-17695A-LG",
      "KKI-17695A-MD",
      "KKI-17695A-SM",
    ]);
    expect(items.map((i) => i.barcode)).toEqual([
      "840220407476-1",
      "840220407476-2",
      "840220407476-3",
    ]);
    const total = items.reduce((sum, i) => sum + i.cost.toNumber(), 0);
    expect(total).toBeCloseTo(56.99, 2);
  });

  it("a row taken off the PO still becomes an item, unassigned (draftPoId null)", async () => {
    const vendor = await prisma.vendor.create({
      data: { name: "Wendover Art Group", code: "WAG" },
    });
    const ctx: HomeAccessoryCommitContext = {
      vendorId: vendor.id,
      vendorName: vendor.name,
      stockLocationId: null,
      buyId: null,
      sourceLabel: "Home Accessory Order Import — Wendover Art Group",
    };
    const rows = [
      effectiveRow({ key: "0", reference: "1000292821", poExcluded: false }),
      effectiveRow({ key: "1", partNumber: "WLD9999", reference: "1000292821", poExcluded: true }),
    ];

    const result = await commitRows(rows, ctx);
    expect(result.createdPos).toHaveLength(1);
    expect(result.itemsCreated).toBe(2);

    const onPo = await prisma.buyerDraftItem.findMany({
      where: { draftPoId: result.createdPos[0].id },
    });
    expect(onPo).toHaveLength(1);

    const unassignedItem = await prisma.buyerDraftItem.findFirstOrThrow({
      where: { partNumber: "WLD9999" },
    });
    expect(unassignedItem.draftPoId).toBeNull();
    expect(unassignedItem.source).toBe("HOME_ACCESSORY_ORDER_IMPORT");
  });

  it("assigns the draft PO to a Buy when one is picked", async () => {
    const vendor = await prisma.vendor.create({ data: { name: "K & K Interiors", code: "KKI" } });
    const buy = await prisma.buyerDraftBuy.create({ data: { name: "Fall 2026 Home Acc" } });
    const ctx: HomeAccessoryCommitContext = {
      vendorId: vendor.id,
      vendorName: vendor.name,
      stockLocationId: null,
      buyId: buy.id,
      sourceLabel: "Home Accessory Order Import — K & K Interiors",
    };

    const result = await commitRows([effectiveRow()], ctx);
    const po = await prisma.buyerDraftPurchaseOrder.findUniqueOrThrow({
      where: { id: result.createdPos[0].id },
    });
    expect(po.buyId).toBe(buy.id);
  });

  it("expectedShipMonth is set from the requiredDateByReference map when present", async () => {
    const vendor = await prisma.vendor.create({ data: { name: "K & K Interiors", code: "KKI" } });
    const ctx: HomeAccessoryCommitContext = {
      vendorId: vendor.id,
      vendorName: vendor.name,
      stockLocationId: null,
      buyId: null,
      requiredDateByReference: { "0002592360": "8/1/26" },
      sourceLabel: "Home Accessory Order Import — K & K Interiors",
    };

    const result = await commitRows([effectiveRow()], ctx);
    const po = await prisma.buyerDraftPurchaseOrder.findUniqueOrThrow({
      where: { id: result.createdPos[0].id },
    });
    expect(po.expectedShipMonth).not.toBeNull();
    expect(po.expectedShipMonth?.getUTCFullYear()).toBe(2026);
    expect(po.expectedShipMonth?.getUTCMonth()).toBe(7); // August, 0-indexed
  });

  it("works with a null vendorId (supplier not matched to a catalog Vendor) — vendorName still free text", async () => {
    const ctx: HomeAccessoryCommitContext = {
      vendorId: null,
      vendorName: "Brand New Vendor Inc",
      stockLocationId: null,
      buyId: null,
      sourceLabel: "Home Accessory Order Import — Brand New Vendor Inc",
    };
    const rows = [effectiveRow({ supplier: "Brand New Vendor Inc" })];

    const result = await commitRows(rows, ctx);
    const po = await prisma.buyerDraftPurchaseOrder.findUniqueOrThrow({
      where: { id: result.createdPos[0].id },
    });
    expect(po.vendorId).toBeNull();
    expect(po.vendorName).toBe("Brand New Vendor Inc");

    const item = await prisma.buyerDraftItem.findFirstOrThrow({
      where: { draftPoId: po.id },
    });
    expect(item.vendorId).toBeNull();
    expect(item.vendorName).toBe("Brand New Vendor Inc");
  });
});
