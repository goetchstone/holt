// /app/src/pages/api/admin/buyer-drafts/export/pos.ts
//
// Purchase Orders CSV export for the POS. ADMIN-only.
//
// GET only. WHERE-clause logic lives in `lib/buyerDraftExportFilters.ts`
// (A-grade unit tested). Same query-param shape + READY-default rules
// as items.ts — see that file's header for details.
//
// Side effect: only stamps READY POs as EXPORTED. POs already in
// other statuses (DRAFT in a buy-scoped export, EXPORTED previously,
// FULFILLED, CANCELLED) pass through unchanged so a buyer's archival
// dump of a CLOSED buy doesn't flip DRAFT POs to EXPORTED.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError, logger } from "@/lib/logger";
import {
  buildPosCsv,
  type DraftItemForExport,
  type DraftPoForExport,
} from "@/lib/buyerDraftExport";
import { buildPosWhere } from "@/lib/buyerDraftExportFilters";
import { Prisma } from "@prisma/client";
import crypto from "node:crypto";

export default requireAuthWithRole(["ADMIN"], async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end();
  }

  const where = buildPosWhere({
    ids: typeof req.query.ids === "string" ? req.query.ids : undefined,
    status: typeof req.query.status === "string" ? req.query.status : undefined,
    vendorId: typeof req.query.vendorId === "string" ? req.query.vendorId : undefined,
    buyId: typeof req.query.buyId === "string" ? req.query.buyId : undefined,
  });
  const dryRun = req.query.dryRun === "1";

  try {
    const pos = await prisma.buyerDraftPurchaseOrder.findMany({
      where,
      include: {
        vendor: { select: { name: true } },
        items: {
          include: {
            vendor: { select: { name: true } },
            department: { select: { name: true } },
            category: { select: { name: true } },
            stockLocation: { select: { code: true } },
          },
          orderBy: [{ partNumber: "asc" }, { id: "asc" }],
        },
      },
      orderBy: [{ id: "asc" }],
    });

    const posForExport: DraftPoForExport[] = pos.map((p) => ({
      id: p.id,
      referenceNumber: p.referenceNumber,
      supplierName: p.vendor?.name ?? p.vendorName,
    }));

    const itemsByPoId = new Map<number, DraftItemForExport[]>();
    for (const p of pos) {
      const items: DraftItemForExport[] = p.items.map((r) => ({
        partNumber: r.partNumber,
        productName: r.productName,
        description: r.description,
        cost: toNumber(r.cost),
        retail: toNumber(r.retail),
        msrp: r.msrp ? toNumber(r.msrp) : null,
        productWidth: r.productWidth ? toNumber(r.productWidth) : null,
        productLength: r.productLength ? toNumber(r.productLength) : null,
        productHeight: r.productHeight ? toNumber(r.productHeight) : null,
        departmentName: r.department?.name ?? null,
        categoryName: r.category?.name ?? null,
        stockFamily: r.stockFamily,
        supplierName: r.vendor?.name ?? r.vendorName,
        qty: r.qty,
        draftPoId: r.draftPoId,
        stockLocationCode: r.stockLocation?.code ?? null,
        barcode: r.barcode,
      }));
      itemsByPoId.set(p.id, items);
    }

    const csv = buildPosCsv(posForExport, itemsByPoId);

    if (!dryRun) {
      await stampExportedRows(pos);
    }

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="buyer-drafts-pos-${stamp()}.csv"`);
    return res.status(200).send(csv);
  } catch (err) {
    logError("buyer-drafts pos export failed", err);
    return res.status(500).json({ error: "Failed to build POs CSV" });
  }
});

// Stamp READY POs → EXPORTED with batch + timestamp; stamp every line
// item's exportedAt + batchId regardless of PO status. POs already in
// EXPORTED / FULFILLED / CANCELLED (or DRAFT in a buy-scoped archival
// export) pass through unchanged so a buyer's archival dump of a CLOSED
// buy doesn't silently flip DRAFT POs to EXPORTED.
async function stampExportedRows(
  pos: ReadonlyArray<{ id: number; status: string; items: ReadonlyArray<{ id: number }> }>,
): Promise<void> {
  if (pos.length === 0) {
    return;
  }
  const readyPoIds = pos.filter((p) => p.status === "READY").map((p) => p.id);
  const itemIds = pos.flatMap((p) => p.items.map((i) => i.id));
  if (readyPoIds.length === 0 && itemIds.length === 0) {
    logger.info("buyer-drafts pos export (no rows stamped)", { poCount: pos.length });
    return;
  }
  const batchId = `pos-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${crypto
    .randomBytes(3)
    .toString("hex")}`;
  const writes: Prisma.PrismaPromise<unknown>[] = [];
  if (readyPoIds.length > 0) {
    writes.push(
      prisma.buyerDraftPurchaseOrder.updateMany({
        where: { id: { in: readyPoIds } },
        data: { status: "EXPORTED", exportedAt: new Date(), exportBatchId: batchId },
      }),
    );
  }
  if (itemIds.length > 0) {
    writes.push(
      prisma.buyerDraftItem.updateMany({
        where: { id: { in: itemIds } },
        data: { exportedAt: new Date(), exportBatchId: batchId },
      }),
    );
  }
  await prisma.$transaction(writes);
  logger.info("buyer-drafts pos export", {
    poCount: pos.length,
    stampedPoCount: readyPoIds.length,
    itemCount: itemIds.length,
    batchId,
  });
}

function toNumber(d: Prisma.Decimal): number {
  return Number(d.toString());
}

function stamp(): string {
  return new Date().toISOString().slice(0, 10);
}
