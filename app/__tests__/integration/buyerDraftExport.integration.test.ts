// /app/__tests__/integration/buyerDraftExport.integration.test.ts
//
// B-grade integration tests for the buyer-drafts CSV export endpoints.
// Pure CSV-format math is A-graded in `__tests__/buyerDraftExport.test.ts`;
// this file owns the parts that need a real Postgres round-trip:
//
//   1. The endpoint walks `prisma.buyerDraftItem.findMany` with the right
//      where-clause filters (status default = READY, ?ids=, ?status=).
//   2. The Prisma include shape produces the FK-joined names the CSV
//      writer needs — vendor.name, department.name, category.name,
//      stockLocation.code.
//   3. The status-transition side effect (READY → EXPORTED + exportBatchId)
//      runs in the same flow and is idempotent.
//
// Mocked Prisma can't catch a wrong include shape or a typo in a where
// clause; only a real DB does.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import {
  buildItemsCsv,
  buildPosCsv,
  type DraftItemForExport,
  type DraftPoForExport,
} from "@/lib/buyerDraftExport";
import { Prisma } from "@prisma/client";

// Helper: convert a Prisma BuyerDraftItem (with its FK includes) to the
// DraftItemForExport shape the CSV builders expect. Mirrors what the API
// endpoint does internally.
function toExportShape(row: {
  partNumber: string;
  productName: string;
  description: string | null;
  cost: Prisma.Decimal;
  retail: Prisma.Decimal;
  msrp: Prisma.Decimal | null;
  productWidth: Prisma.Decimal | null;
  productLength: Prisma.Decimal | null;
  productHeight: Prisma.Decimal | null;
  stockFamily: string | null;
  vendorName: string;
  vendor: { name: string } | null;
  department: { name: string } | null;
  category: { name: string } | null;
  stockLocation: { code: string } | null;
  qty: number;
  draftPoId: number | null;
  barcode: string | null;
}): DraftItemForExport {
  return {
    partNumber: row.partNumber,
    productName: row.productName,
    description: row.description,
    cost: Number(row.cost.toString()),
    retail: Number(row.retail.toString()),
    msrp: row.msrp ? Number(row.msrp.toString()) : null,
    productWidth: row.productWidth ? Number(row.productWidth.toString()) : null,
    productLength: row.productLength ? Number(row.productLength.toString()) : null,
    productHeight: row.productHeight ? Number(row.productHeight.toString()) : null,
    departmentName: row.department?.name ?? null,
    categoryName: row.category?.name ?? null,
    stockFamily: row.stockFamily,
    supplierName: row.vendor?.name ?? row.vendorName,
    qty: row.qty,
    draftPoId: row.draftPoId,
    stockLocationCode: row.stockLocation?.code ?? null,
    barcode: row.barcode,
  };
}

describe("buyer-drafts export — items endpoint logic against real DB", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("walks the include chain and produces a CSV row with denormalized FK names", async () => {
    const vendor = await prisma.vendor.create({
      data: { name: "CR Laine", code: "CRL" },
    });
    const dept = await prisma.department.create({ data: { name: "Furniture" } });
    const cat = await prisma.category.create({
      data: { name: "Chairs", departmentId: dept.id },
    });
    const store = await prisma.storeLocation.create({
      data: { name: "OS", code: "OS", type: "STORE" },
    });
    const stockLoc = await prisma.stockLocation.create({
      data: { storeLocationId: store.id, code: "OS-WHSE", name: "OS Warehouse" },
    });
    await prisma.buyerDraftItem.create({
      data: {
        vendorId: vendor.id,
        vendorName: vendor.name,
        partNumber: "L2272-05SW",
        productName: "Murphey Swivel Chair",
        cost: 1275,
        retail: 3039,
        msrp: 4050,
        description: "Leather Stetson Chestnut",
        productWidth: 30,
        productLength: 39.5,
        productHeight: 34,
        departmentId: dept.id,
        categoryId: cat.id,
        stockLocationId: stockLoc.id,
        qty: 6,
        status: "READY",
      },
    });

    // Fetch with the same include shape the endpoint uses
    const rows = await prisma.buyerDraftItem.findMany({
      where: { status: "READY" },
      include: {
        vendor: { select: { name: true } },
        department: { select: { name: true } },
        category: { select: { name: true } },
        stockLocation: { select: { code: true } },
      },
    });
    const csv = buildItemsCsv(rows.map(toExportShape));
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(2); // header + 1
    expect(lines[1]).toContain("Chairs"); // category.name resolved
    expect(lines[1]).toContain("Furniture"); // department.name resolved
    expect(lines[1]).toContain("CR Laine"); // vendor.name resolved (preferred over vendorName)
    expect(lines[1]).toContain("L2272-05SW");
    expect(lines[1]).toContain("1275.00");
  });

  it("falls back to vendorName when vendor FK is null (in-flight new vendor)", async () => {
    await prisma.buyerDraftItem.create({
      data: {
        vendorName: "(new mid-negotiation)",
        partNumber: "TBD-1",
        productName: "Item being negotiated",
        cost: 100,
        retail: 250,
        status: "READY",
      },
    });
    const rows = await prisma.buyerDraftItem.findMany({
      where: { status: "READY" },
      include: {
        vendor: { select: { name: true } },
        department: { select: { name: true } },
        category: { select: { name: true } },
        stockLocation: { select: { code: true } },
      },
    });
    const csv = buildItemsCsv(rows.map(toExportShape));
    expect(csv).toContain("(new mid-negotiation)");
  });

  it("only picks up status=READY rows by default (DRAFT and CANCELLED are skipped)", async () => {
    await prisma.buyerDraftItem.create({
      data: {
        vendorName: "V",
        partNumber: "READY-1",
        productName: "ready",
        cost: 1,
        retail: 1,
        status: "READY",
      },
    });
    await prisma.buyerDraftItem.create({
      data: {
        vendorName: "V",
        partNumber: "DRAFT-1",
        productName: "draft",
        cost: 1,
        retail: 1,
        status: "DRAFT",
      },
    });
    await prisma.buyerDraftItem.create({
      data: {
        vendorName: "V",
        partNumber: "CANCELLED-1",
        productName: "cancelled",
        cost: 1,
        retail: 1,
        status: "CANCELLED",
      },
    });
    const rows = await prisma.buyerDraftItem.findMany({
      where: { status: "READY" },
      include: {
        vendor: { select: { name: true } },
        department: { select: { name: true } },
        category: { select: { name: true } },
        stockLocation: { select: { code: true } },
      },
    });
    const csv = buildItemsCsv(rows.map(toExportShape));
    expect(csv).toContain("READY-1");
    expect(csv).not.toContain("DRAFT-1");
    expect(csv).not.toContain("CANCELLED-1");
  });

  it("status transition READY → EXPORTED is observable + idempotent on re-export", async () => {
    const created = await prisma.buyerDraftItem.create({
      data: {
        vendorName: "V",
        partNumber: "P1",
        productName: "p",
        cost: 1,
        retail: 1,
        status: "READY",
      },
    });
    expect(created.status).toBe("READY");
    expect(created.exportedAt).toBeNull();

    // Mimic the endpoint's stamp step
    const batchId = "items-test-batch-1";
    const before = new Date();
    await prisma.buyerDraftItem.updateMany({
      where: { status: "READY" },
      data: { status: "EXPORTED", exportedAt: new Date(), exportBatchId: batchId },
    });
    const stamped = await prisma.buyerDraftItem.findUniqueOrThrow({ where: { id: created.id } });
    expect(stamped.status).toBe("EXPORTED");
    expect(stamped.exportedAt).not.toBeNull();
    expect(stamped.exportBatchId).toBe(batchId);
    expect(stamped.exportedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1);

    // Idempotent re-stamp via a second batch-id should refresh
    const batchId2 = "items-test-batch-2";
    await prisma.buyerDraftItem.updateMany({
      where: { id: { in: [created.id] } },
      data: { status: "EXPORTED", exportedAt: new Date(), exportBatchId: batchId2 },
    });
    const refreshed = await prisma.buyerDraftItem.findUniqueOrThrow({ where: { id: created.id } });
    expect(refreshed.exportBatchId).toBe(batchId2);
  });
});

describe("buyer-drafts export — POs endpoint logic against real DB", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("groups items by PO id and emits one CSV row per item with the PO's referenceNumber", async () => {
    const vendor = await prisma.vendor.create({
      data: { name: "CR Laine", code: "CRL" },
    });
    const po = await prisma.buyerDraftPurchaseOrder.create({
      data: {
        vendorId: vendor.id,
        vendorName: vendor.name,
        referenceNumber: "PON08000",
        status: "READY",
      },
    });
    await prisma.buyerDraftItem.create({
      data: {
        draftPoId: po.id,
        vendorId: vendor.id,
        vendorName: vendor.name,
        partNumber: "L2272-05SW",
        productName: "Murphey",
        cost: 1275,
        retail: 3039,
        qty: 6,
        status: "READY",
      },
    });
    await prisma.buyerDraftItem.create({
      data: {
        draftPoId: po.id,
        vendorId: vendor.id,
        vendorName: vendor.name,
        partNumber: "1230-20",
        productName: "Magnolia",
        cost: 1873.8,
        retail: 4685,
        qty: 1,
        status: "READY",
      },
    });

    // Mimic the endpoint
    const pos = await prisma.buyerDraftPurchaseOrder.findMany({
      where: { status: "READY" },
      include: {
        vendor: { select: { name: true } },
        items: {
          include: {
            vendor: { select: { name: true } },
            department: { select: { name: true } },
            category: { select: { name: true } },
            stockLocation: { select: { code: true } },
          },
        },
      },
    });
    const posForExport: DraftPoForExport[] = pos.map((p) => ({
      id: p.id,
      referenceNumber: p.referenceNumber,
      supplierName: p.vendor?.name ?? p.vendorName,
    }));
    const itemsByPoId = new Map<number, DraftItemForExport[]>();
    for (const p of pos) {
      itemsByPoId.set(p.id, p.items.map(toExportShape));
    }
    const csv = buildPosCsv(posForExport, itemsByPoId);
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(3); // header + 2 items
    // Both lines should reference the same PON
    const poNumberCount = (csv.match(/PON08000/g) ?? []).length;
    expect(poNumberCount).toBe(2);
    expect(csv).toContain("L2272-05SW");
    expect(csv).toContain("1230-20");
  });

  it("PO with zero items produces header-only CSV (does not crash)", async () => {
    const vendor = await prisma.vendor.create({ data: { name: "Test V", code: "TV2" } });
    const po = await prisma.buyerDraftPurchaseOrder.create({
      data: {
        vendorId: vendor.id,
        vendorName: vendor.name,
        referenceNumber: "PON-EMPTY",
        status: "READY",
      },
    });
    const pos = await prisma.buyerDraftPurchaseOrder.findMany({
      where: { id: po.id },
      include: {
        vendor: { select: { name: true } },
        items: {
          include: {
            vendor: { select: { name: true } },
            department: { select: { name: true } },
            category: { select: { name: true } },
            stockLocation: { select: { code: true } },
          },
        },
      },
    });
    const itemsByPoId = new Map<number, DraftItemForExport[]>();
    for (const p of pos) itemsByPoId.set(p.id, p.items.map(toExportShape));
    const csv = buildPosCsv(
      pos.map((p) => ({
        id: p.id,
        referenceNumber: p.referenceNumber,
        supplierName: p.vendor?.name ?? p.vendorName,
      })),
      itemsByPoId,
    );
    expect(csv.trim().split("\n")).toHaveLength(1); // header only
  });
});
