// /app/src/pages/api/admin/buyer-drafts/export/items.ts
//
// Items CSV export for the POS. ADMIN-only.
//
// GET only. WHERE-clause logic lives in `lib/buyerDraftExportFilters.ts`
// (A-grade unit tested). Supported query params:
//
//   ?ids=1,2,3     limit to specific item ids
//   ?status=DRAFT  override the legacy READY default
//   ?vendorId=N    scope to a single vendor
//   ?buyId=N       scope to one Buy (matches BuyerDraftItem.draftPo.buyId)
//   ?buyId=unassigned  match items whose PO has no Buy assignment
//   ?dryRun=1      build the CSV but skip the EXPORTED stamp
//
// Defaults — same module: when NO ids, NO buyId, AND NO explicit
// status are passed, falls back to `status = READY` for the legacy
// production-handoff flow. Passing ids OR buyId is the caller saying
// "give me everything in this scope" and the READY default is dropped.
//
// Side effect: rows that exit DRAFT/READY for the first time get
// `exportedAt` + `status: EXPORTED` stamped, and `exportBatchId` set
// so we can identify which CSV they shipped on. Idempotent.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError, logger } from "@/lib/logger";
import { buildItemsCsv, type DraftItemForExport } from "@/lib/buyerDraftExport";
import { assembleDescriptionForExport } from "@/lib/buyerDraftRequestBody";
import { buildItemsWhere } from "@/lib/buyerDraftExportFilters";
import { Prisma } from "@prisma/client";
import crypto from "node:crypto";

export default requireAuthWithRole(["ADMIN"], async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end();
  }

  const where = buildItemsWhere({
    ids: typeof req.query.ids === "string" ? req.query.ids : undefined,
    status: typeof req.query.status === "string" ? req.query.status : undefined,
    vendorId: typeof req.query.vendorId === "string" ? req.query.vendorId : undefined,
    buyId: typeof req.query.buyId === "string" ? req.query.buyId : undefined,
  });
  const dryRun = req.query.dryRun === "1";

  try {
    const rows = await prisma.buyerDraftItem.findMany({
      where,
      include: {
        vendor: { select: { name: true } },
        department: { select: { name: true } },
        category: { select: { name: true } },
        stockLocation: { select: { code: true } },
      },
      orderBy: [{ vendorName: "asc" }, { partNumber: "asc" }],
    });

    const exportRows: DraftItemForExport[] = rows.map((r) => ({
      partNumber: r.partNumber,
      productName: r.productName,
      // Per buyer feedback 2026-05-09: the POS import expects multi-line
      // descriptions so each field renders on its own line in the product
      // card. Assemble fresh from structured fields when available; fall
      // back to the stored free-text otherwise.
      description: descriptionForExport(r),
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

    const csv = buildItemsCsv(exportRows);

    if (!dryRun && rows.length > 0) {
      // Only stamp READY rows → EXPORTED. DRAFT items pulled into a
      // buy-scoped export (e.g. archival dump of a CLOSED buy) are
      // review-only artifacts; the buyer hasn't committed them as
      // ready-to-ship. EXPORTED / FULFILLED / CANCELLED rows are
      // pass-through (no status change). Stamps timestamp + batchId
      // on the READY rows the same as before so audit trails for
      // production handoffs are unchanged.
      const readyIds = rows.filter((r) => r.status === "READY").map((r) => r.id);
      if (readyIds.length > 0) {
        const batchId = `items-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${crypto
          .randomBytes(3)
          .toString("hex")}`;
        await prisma.buyerDraftItem.updateMany({
          where: { id: { in: readyIds } },
          data: {
            status: "EXPORTED",
            exportedAt: new Date(),
            exportBatchId: batchId,
          },
        });
        logger.info("buyer-drafts items export", {
          rowCount: rows.length,
          stampedCount: readyIds.length,
          batchId,
        });
      } else {
        logger.info("buyer-drafts items export (no rows stamped)", { rowCount: rows.length });
      }
    }

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="buyer-drafts-items-${stamp()}.csv"`,
    );
    return res.status(200).send(csv);
  } catch (err) {
    logError("buyer-drafts items export failed", err);
    return res.status(500).json({ error: "Failed to build items CSV" });
  }
});

function toNumber(d: Prisma.Decimal): number {
  return Number(d.toString());
}

function stamp(): string {
  return new Date().toISOString().slice(0, 10);
}

// Build the description string for the items CSV. If the row has any
// structured fields (any of the slice 4a / slice 4-lite-v2 fields),
// re-assemble them with newlines per `assembleDescriptionForExport` —
// the POS's product card displays each field on its own line. If only
// free-text was entered (no structured fields), pass the stored
// description through unchanged so the buyer's typed content is preserved
// verbatim including any line breaks they put in themselves.
function descriptionForExport(row: {
  description: string | null;
  itemType: import("@prisma/client").BuyerDraftItemType;
  grade: string | null;
  fabric: string | null;
  finish: string | null;
  cleaningCode: string | null;
  options: string | null;
  cushions: string | null;
  tossPillows: string | null;
  hardware: string | null;
  hardwareFinish: string | null;
  productWidth: Prisma.Decimal | null;
  productLength: Prisma.Decimal | null;
  productHeight: Prisma.Decimal | null;
}): string | null {
  const hasStructured =
    row.itemType !== "OTHER" ||
    Boolean(row.grade) ||
    Boolean(row.fabric) ||
    Boolean(row.finish) ||
    Boolean(row.cleaningCode) ||
    Boolean(row.options) ||
    Boolean(row.cushions) ||
    Boolean(row.tossPillows) ||
    Boolean(row.hardware) ||
    Boolean(row.hardwareFinish);

  if (hasStructured) {
    return (
      assembleDescriptionForExport({
        itemType: row.itemType,
        fabric: row.fabric,
        grade: row.grade,
        finish: row.finish,
        cleaningCode: row.cleaningCode,
        options: row.options,
        cushions: row.cushions,
        tossPillows: row.tossPillows,
        hardware: row.hardware,
        hardwareFinish: row.hardwareFinish,
        productWidth: row.productWidth ? Number(row.productWidth.toString()) : null,
        productLength: row.productLength ? Number(row.productLength.toString()) : null,
        productHeight: row.productHeight ? Number(row.productHeight.toString()) : null,
      }) || null
    );
  }
  return row.description;
}
