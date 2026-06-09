// /app/src/pages/api/admin/buyer-drafts/products/lookup-by-barcode.ts
//
// Slice 4.5 (2026-05-12) — barcode lookup of existing Products. The
// BarcodeLookupModal hits this endpoint as the buyer scans / types a
// UPC; on a hit it builds a draft-item-create body via
// `lib/buyerDraftFromProduct.ts` and POSTs to the items endpoint.
//
// ADMIN-only. GET only.
//
// Query:    ?barcode=<upc-string>
// Response: 200 { product: {...}, draftBody: {...} } on match
//           404 { error: "Not found" } when no Product owns this UPC

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import { buildDraftBodyFromProduct, type ProductForDraft } from "@/lib/buyerDraftFromProduct";
import {
  computeFrameSalesHistory,
  trailingWindowStart,
  type FrameSaleLine,
} from "@/lib/frameSalesHistory";
import { stripLastSegment } from "@/lib/frameRollup";
import { SALES_REVENUE_STATUSES } from "@/lib/salesOrderRevenue";

export default requireAuthWithRole(["ADMIN"], async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end();
  }

  const barcode = typeof req.query.barcode === "string" ? req.query.barcode.trim() : "";
  if (!barcode) {
    return res.status(400).json({ error: "barcode query param is required" });
  }

  try {
    // Match by UPC — one Product can carry multiple UPCs (Marjan
    // rugs etc.), so we go via the join table.
    const upc = await prisma.upc.findFirst({
      where: { upc: barcode },
      select: {
        product: {
          select: {
            id: true,
            productNumber: true,
            name: true,
            vendorId: true,
            vendor: { select: { name: true } },
            departmentId: true,
            categoryId: true,
            typeId: true,
            baseCost: true,
            baseRetail: true,
            mapPrice: true,
            width: true,
            depth: true,
            height: true,
            isActive: true,
            isDiscontinued: true,
          },
        },
      },
    });

    if (!upc?.product) {
      return res.status(404).json({ error: "No product found for that barcode" });
    }

    const product = upc.product;
    const draftBody = buildDraftBodyFromProduct(product as ProductForDraft);

    // Slice 6.12 (2026-05-14) — frame-aware L12M sales history. Helps
    // the buyer make an informed qty decision at the scan-and-add
    // moment: "this frame sold 14 units last year" → order 12.
    const salesHistory = await computeFrameSalesHistoryForProduct(product.id, product.vendorId);

    return res.status(200).json({
      product: {
        id: product.id,
        productNumber: product.productNumber,
        name: product.name,
        vendorName: product.vendor.name,
        // Surface so the modal can warn the buyer if they're about
        // to re-order something the vendor has discontinued.
        isActive: product.isActive,
        isDiscontinued: product.isDiscontinued,
        cost: product.baseCost?.toString() ?? null,
        retail: product.baseRetail?.toString() ?? null,
      },
      draftBody,
      salesHistory,
    });
  } catch (err) {
    logError("buyer-drafts barcode lookup failed", err);
    return res.status(500).json({ error: "Lookup failed" });
  }
});

/**
 * Slice 6.12 — pull frame-mate Products for the same SKU stem +
 * vendor, then sum their trailing-12-months sales. Returns null when
 * frame inference fails (productNumber missing or stem can't be
 * extracted) so the modal can decide to hide the history badge.
 */
async function computeFrameSalesHistoryForProduct(
  productId: number,
  vendorId: number,
): Promise<{
  units: number;
  revenue: number;
  distinctOrders: number;
  windowMonths: number;
} | null> {
  const focus = await prisma.product.findUnique({
    where: { id: productId },
    select: { productNumber: true },
  });
  if (!focus?.productNumber) return null;
  const stem = stripLastSegment(focus.productNumber);

  // Find every Product in the same vendor whose productNumber stem
  // matches. This is the frame — could be 1 row (no variants exist),
  // could be many.
  const frameMates = await prisma.product.findMany({
    where: { vendorId },
    select: { id: true, productNumber: true },
  });
  const matedIds = frameMates
    .filter((p) => stripLastSegment(p.productNumber) === stem)
    .map((p) => p.id);
  if (matedIds.length === 0) return null;

  const windowMonths = 12;
  const windowStart = trailingWindowStart(new Date(), windowMonths);

  const lines = await prisma.orderLineItem.findMany({
    where: {
      productId: { in: matedIds },
      lineItemStatus: { not: "CANCELLED" },
      salesOrder: {
        status: { in: [...SALES_REVENUE_STATUSES] },
        orderDate: { gte: windowStart },
      },
    },
    select: {
      orderedQuantity: true,
      netPrice: true,
      salesOrderId: true,
    },
  });

  const saleLines: FrameSaleLine[] = lines.map((l) => ({
    qty: Number(l.orderedQuantity.toString()),
    netPrice: Number(l.netPrice.toString()),
    salesOrderId: l.salesOrderId,
  }));
  return computeFrameSalesHistory(saleLines, windowMonths);
}
