// /app/src/pages/api/admin/buyer-drafts/export/workbook.ts
//
// Buyer's workbook XLSX export — matches the buyer's existing OTB
// workbook shape (TOTAL pivot + per-vendor sheets + Floor Plan).
//
// ADMIN-only. WHERE-clause logic lives in
// `lib/buyerDraftExportFilters.ts:buildWorkbookItemsWhere` (A-grade
// unit tested). Supported query params:
//
//   ?ids=1,2,3     limit to specific item ids
//   ?status=DRAFT  filter by status (no default — workbook is a
//                  review artifact; buyer wants the whole picture)
//   ?vendorId=N    scope to a single vendor
//   ?buyId=N       scope to one Buy
//   ?buyId=unassigned  items whose PO has no Buy assignment
//
// Unlike items.ts / pos.ts, we DO NOT stamp `status=EXPORTED` here —
// the workbook is a buyer-side artifact for review/sharing, not a
// system-of-record handoff.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError, logger } from "@/lib/logger";
import { Prisma } from "@prisma/client";
import { buildBuyerWorkbook, type WorkbookItem, type WorkbookBuy } from "@/lib/buyerDraftWorkbook";
import { buildWorkbookItemsWhere } from "@/lib/buyerDraftExportFilters";
import { getAppSettings } from "@/lib/appSettings";
import * as XLSX from "xlsx";

export default requireAuthWithRole(["ADMIN"], async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end();
  }

  const where = buildWorkbookItemsWhere({
    ids: typeof req.query.ids === "string" ? req.query.ids : undefined,
    status: typeof req.query.status === "string" ? req.query.status : undefined,
    vendorId: typeof req.query.vendorId === "string" ? req.query.vendorId : undefined,
    buyId: typeof req.query.buyId === "string" ? req.query.buyId : undefined,
  });

  try {
    const [rows, buyRows] = await Promise.all([
      prisma.buyerDraftItem.findMany({
        where,
        include: {
          vendor: { select: { name: true } },
          stockLocation: {
            select: {
              code: true,
              name: true,
              storeLocation: { select: { name: true, code: true } },
            },
          },
          // include the PO's Buy so we can attribute item spend to a Buy
          // for the workbook's Buys summary sheet (slice 4-buys).
          draftPo: {
            select: {
              referenceNumber: true,
              expectedShipMonth: true,
              buy: { select: { name: true } },
            },
          },
          // 2026-05-13 — for items created via barcode lookup the
          // catalog Product is linked at create time (Slice 4.5 + 6.1).
          // Surface its productNumber as the SKU# column and its
          // description as a fallback when the draft itself has none.
          fulfilledProduct: {
            select: { productNumber: true, description: true },
          },
        },
        orderBy: [{ vendorName: "asc" }, { partNumber: "asc" }],
      }),
      prisma.buyerDraftBuy.findMany({
        select: { name: true, season: true, year: true, status: true, budget: true },
        orderBy: [{ year: "desc" }, { created: "desc" }],
      }),
    ]);

    const items: WorkbookItem[] = rows.map((r) => ({
      partNumber: r.partNumber,
      productName: r.productName,
      // Fallback chain: draft's own description → linked Product's
      // description → empty. Matches the Slice 6.1 display fallback so
      // the workbook reflects what the buyer sees on the card.
      description: r.description ?? r.fulfilledProduct?.description ?? null,
      barcode: r.barcode ?? null,
      qty: r.qty,
      cost: toNumber(r.cost),
      retail: toNumber(r.retail),
      msrp: r.msrp ? toNumber(r.msrp) : null,
      // SKU# = the catalog Product's productNumber once linked.
      // Distinct from the buyer's `partNumber` which may diverge for
      // re-orders or new items.
      sku: r.fulfilledProduct?.productNumber ?? null,
      poReference: r.draftPo?.referenceNumber ?? null,
      supplierName: r.vendor?.name ?? r.vendorName,
      storeLocationName: r.stockLocation?.storeLocation?.name ?? r.stockLocation?.name ?? null,
      storeLocationCode: r.stockLocation?.storeLocation?.code ?? r.stockLocation?.code ?? null,
      vignette: r.vignette,
      stockProgram: r.stockProgram,
      expectedShipMonth: r.draftPo?.expectedShipMonth ?? null,
      buyName: r.draftPo?.buy?.name ?? null,
    }));

    const buys: WorkbookBuy[] = buyRows.map((b) => ({
      name: b.name,
      season: b.season,
      year: b.year,
      status: b.status,
      budget: b.budget ? toNumber(b.budget) : null,
    }));

    const settings = await getAppSettings();
    const wb = buildBuyerWorkbook(items, {
      title: `Buyer Drafts — ${new Date().toISOString().slice(0, 10)}`,
      author: `${settings.companyName ?? settings.appName}`,
      buys,
    });

    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    logger.info("buyer-drafts workbook export", {
      itemCount: items.length,
      vendorCount: new Set(items.map((i) => i.supplierName)).size,
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="buyer-drafts-workbook-${stamp()}.xlsx"`,
    );
    return res.status(200).send(buffer);
  } catch (err) {
    logError("buyer-drafts workbook export failed", err);
    return res.status(500).json({ error: "Failed to build workbook" });
  }
});

function toNumber(d: Prisma.Decimal): number {
  return Number(d.toString());
}

function stamp(): string {
  return new Date().toISOString().slice(0, 10);
}
