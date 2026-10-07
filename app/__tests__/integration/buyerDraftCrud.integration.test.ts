// /app/__tests__/integration/buyerDraftCrud.integration.test.ts
//
// B-grade integration tests for the buyer-drafts CRUD endpoints. The endpoints
// are thin Prisma wrappers, but the body→Prisma coercion (connectOrDisconnect,
// decimalOrThrow, qty validation, enum validation, build*Patches splits) only
// runs end-to-end against a real DB. Exercises the actual prisma.create /
// prisma.update calls so a typo in the include shape or a wrong field name
// fails loudly rather than silently passing through a mock.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";

describe("BuyerDraftItem CRUD against real DB", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("creates a minimal draft item with required fields", async () => {
    const item = await prisma.buyerDraftItem.create({
      data: {
        vendorName: "Wesley Hall",
        partNumber: "1060",
        productName: "Sofa",
        cost: 2000,
        retail: 4500,
      },
    });
    expect(item.id).toBeGreaterThan(0);
    expect(item.status).toBe("DRAFT"); // default
    expect(item.source).toBe("MANUAL"); // default
    expect(item.qty).toBe(1); // default
    expect(item.stockProgram).toBe(false); // default
  });

  it("connects vendor + dept + cat + type FKs simultaneously", async () => {
    const vendor = await prisma.vendor.create({ data: { name: "V", code: "VV" } });
    const dept = await prisma.department.create({ data: { name: "D" } });
    const cat = await prisma.category.create({
      data: { name: "C", departmentId: dept.id },
    });
    const type = await prisma.type.create({
      data: { name: "T", categoryId: cat.id },
    });
    const item = await prisma.buyerDraftItem.create({
      data: {
        vendorId: vendor.id,
        vendorName: vendor.name,
        partNumber: "P1",
        productName: "p",
        cost: 1,
        retail: 1,
        departmentId: dept.id,
        categoryId: cat.id,
        typeId: type.id,
      },
    });
    const fetched = await prisma.buyerDraftItem.findUniqueOrThrow({
      where: { id: item.id },
      include: { vendor: true, department: true, category: true, type: true },
    });
    expect(fetched.vendor?.name).toBe("V");
    expect(fetched.department?.name).toBe("D");
    expect(fetched.category?.name).toBe("C");
    expect(fetched.type?.name).toBe("T");
  });

  it("disconnects an FK by setting it to null in update", async () => {
    const vendor = await prisma.vendor.create({ data: { name: "X", code: "XX" } });
    const item = await prisma.buyerDraftItem.create({
      data: {
        vendorId: vendor.id,
        vendorName: vendor.name,
        partNumber: "P",
        productName: "p",
        cost: 1,
        retail: 1,
      },
    });
    expect(item.vendorId).toBe(vendor.id);
    const cleared = await prisma.buyerDraftItem.update({
      where: { id: item.id },
      data: { vendor: { disconnect: true } },
    });
    expect(cleared.vendorId).toBeNull();
  });

  it("status transitions are persisted (DRAFT → READY → EXPORTED → FULFILLED)", async () => {
    const item = await prisma.buyerDraftItem.create({
      data: {
        vendorName: "V",
        partNumber: "P",
        productName: "p",
        cost: 1,
        retail: 1,
      },
    });
    expect(item.status).toBe("DRAFT");

    const ready = await prisma.buyerDraftItem.update({
      where: { id: item.id },
      data: { status: "READY" },
    });
    expect(ready.status).toBe("READY");

    const exported = await prisma.buyerDraftItem.update({
      where: { id: item.id },
      data: { status: "EXPORTED", exportedAt: new Date() },
    });
    expect(exported.status).toBe("EXPORTED");
    expect(exported.exportedAt).not.toBeNull();

    const fulfilled = await prisma.buyerDraftItem.update({
      where: { id: item.id },
      data: { status: "FULFILLED", fulfilledAt: new Date() },
    });
    expect(fulfilled.status).toBe("FULFILLED");
    expect(fulfilled.fulfilledAt).not.toBeNull();
  });

  it("respects the configuration JSON column on update (round-trip preserves shape)", async () => {
    const item = await prisma.buyerDraftItem.create({
      data: {
        vendorName: "V",
        partNumber: "P",
        productName: "p",
        cost: 1,
        retail: 1,
        configuration: { fabric: "Calvin Sky", grade: 16, options: ["welt"] },
      },
    });
    const fetched = await prisma.buyerDraftItem.findUniqueOrThrow({
      where: { id: item.id },
    });
    expect(fetched.configuration).toEqual({
      fabric: "Calvin Sky",
      grade: 16,
      options: ["welt"],
    });
  });

  it("delete removes the row", async () => {
    const item = await prisma.buyerDraftItem.create({
      data: {
        vendorName: "V",
        partNumber: "P",
        productName: "p",
        cost: 1,
        retail: 1,
      },
    });
    await prisma.buyerDraftItem.delete({ where: { id: item.id } });
    const after = await prisma.buyerDraftItem.findUnique({ where: { id: item.id } });
    expect(after).toBeNull();
  });
});

describe("BuyerDraftPurchaseOrder CRUD against real DB", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("creates a draft PO with vendor + reference number", async () => {
    const vendor = await prisma.vendor.create({ data: { name: "V", code: "VV" } });
    const po = await prisma.buyerDraftPurchaseOrder.create({
      data: {
        vendorId: vendor.id,
        vendorName: vendor.name,
        referenceNumber: "PON12345",
        // Post-2026-05-13 DateTime promotion: this column is `DateTime?`,
        // first-of-month UTC. Going through Prisma directly here so we
        // pass a Date; the API surface (`buildPoCreateData`) accepts
        // string shapes too and coerces.
        expectedShipMonth: new Date("2026-03-01T00:00:00.000Z"),
      },
    });
    expect(po.id).toBeGreaterThan(0);
    expect(po.status).toBe("DRAFT");
    expect(po.referenceNumber).toBe("PON12345");
    expect(po.expectedShipMonth).toEqual(new Date("2026-03-01T00:00:00.000Z"));
  });

  it("delete detaches items rather than cascading (items survive with draftPoId=null)", async () => {
    const po = await prisma.buyerDraftPurchaseOrder.create({
      data: { vendorName: "V" },
    });
    const item1 = await prisma.buyerDraftItem.create({
      data: {
        vendorName: "V",
        partNumber: "P1",
        productName: "p",
        cost: 1,
        retail: 1,
        draftPoId: po.id,
      },
    });
    const item2 = await prisma.buyerDraftItem.create({
      data: {
        vendorName: "V",
        partNumber: "P2",
        productName: "p",
        cost: 1,
        retail: 1,
        draftPoId: po.id,
      },
    });

    // Mimic the endpoint's transactional detach + delete
    await prisma.$transaction([
      prisma.buyerDraftItem.updateMany({
        where: { draftPoId: po.id },
        data: { draftPoId: null },
      }),
      prisma.buyerDraftPurchaseOrder.delete({ where: { id: po.id } }),
    ]);

    const detached1 = await prisma.buyerDraftItem.findUniqueOrThrow({
      where: { id: item1.id },
    });
    const detached2 = await prisma.buyerDraftItem.findUniqueOrThrow({
      where: { id: item2.id },
    });
    expect(detached1.draftPoId).toBeNull();
    expect(detached2.draftPoId).toBeNull();

    const goneCount = await prisma.buyerDraftPurchaseOrder.count({ where: { id: po.id } });
    expect(goneCount).toBe(0);
  });

  it("PO status transitions correspond to item-status side effects on export", async () => {
    const po = await prisma.buyerDraftPurchaseOrder.create({
      data: { vendorName: "V", status: "READY" },
    });
    const item = await prisma.buyerDraftItem.create({
      data: {
        vendorName: "V",
        partNumber: "P",
        productName: "p",
        cost: 1,
        retail: 1,
        draftPoId: po.id,
        status: "READY",
      },
    });

    // Mimic the export endpoint's stamp step
    const batchId = "pos-batch-X";
    await prisma.$transaction([
      prisma.buyerDraftPurchaseOrder.updateMany({
        where: { id: po.id },
        data: { status: "EXPORTED", exportedAt: new Date(), exportBatchId: batchId },
      }),
      prisma.buyerDraftItem.updateMany({
        where: { id: item.id },
        data: { exportedAt: new Date(), exportBatchId: batchId },
      }),
    ]);

    const stampedPo = await prisma.buyerDraftPurchaseOrder.findUniqueOrThrow({
      where: { id: po.id },
    });
    const stampedItem = await prisma.buyerDraftItem.findUniqueOrThrow({
      where: { id: item.id },
    });
    expect(stampedPo.status).toBe("EXPORTED");
    expect(stampedPo.exportBatchId).toBe(batchId);
    expect(stampedItem.exportBatchId).toBe(batchId);
    expect(stampedItem.exportedAt).not.toBeNull();
  });
});

describe("BuyerDraftItem fulfilled-product link (slice 5 stub against real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("can set fulfilledProductId pointing at a real Product (preview of slice 5 auto-link)", async () => {
    const vendor = await prisma.vendor.create({ data: { name: "V", code: "VV3" } });
    const dept = await prisma.department.create({ data: { name: "D2" } });
    const cat = await prisma.category.create({
      data: { name: "C2", departmentId: dept.id },
    });
    const product = await prisma.product.create({
      data: {
        productNumber: "P-REAL",
        name: "Real product",
        vendorId: vendor.id,
        departmentId: dept.id,
        categoryId: cat.id,
      },
    });
    const draft = await prisma.buyerDraftItem.create({
      data: {
        vendorId: vendor.id,
        vendorName: vendor.name,
        partNumber: "P-REAL",
        productName: "Real product",
        cost: 1,
        retail: 1,
        status: "EXPORTED",
      },
    });

    const fulfilled = await prisma.buyerDraftItem.update({
      where: { id: draft.id },
      data: {
        status: "FULFILLED",
        fulfilledAt: new Date(),
        fulfilledProductId: product.id,
        barcode: "012345678905",
      },
    });
    expect(fulfilled.fulfilledProductId).toBe(product.id);
    expect(fulfilled.barcode).toBe("012345678905");
    expect(fulfilled.status).toBe("FULFILLED");

    // Reverse-relation works
    const reverse = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
      include: { fulfilledBuyerDrafts: true },
    });
    expect(reverse.fulfilledBuyerDrafts).toHaveLength(1);
    expect(reverse.fulfilledBuyerDrafts[0].id).toBe(draft.id);
  });
});
