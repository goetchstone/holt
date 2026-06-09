// /app/src/pages/api/admin/buyer-drafts/buys/[id]/linked-pos.ts
//
// Returns the empirical link between a Buy's buyer-draft items and
// real the POS PurchaseOrder rows. Joining condition is
// `BuyerDraftItem.fulfilledProductId === PurchaseOrderItem.productId`
// — the link the buyer set at draft-time via barcode-lookup, catalog
// picker, or slice 5 auto-link.
//
// Used by the Buy performance page to show "real POs covering this
// Buy" with 1:N relationships handled (one draft PO can map to
// multiple real PONs — confirmed empirically against Spring 2026
// where draft PO 3 / Bradington Young covered PON07054 + PON07576 +
// PON08313). Also surfaces draft items that aren't yet linked
// anywhere (`no-link`) or whose Product isn't on any real PO yet
// (`not-on-any-real-po`) so the buyer can investigate.
//
// ADMIN-only, GET only. Read-only across BuyerDraftItem +
// BuyerDraftPurchaseOrder + PurchaseOrder + PurchaseOrderItem.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import {
  computeLinkedPos,
  detectVendorMismatches,
  type DraftItemInput,
  type DraftPoInput,
  type RealPoInput,
  type RealPoLineInput,
  type VendorMismatchInput,
} from "@/lib/buyerDraftRealPoLink";
import { computeBuyLinkCutoff } from "@/lib/buyerDraftBuyLinkCutoff";

export default requireAuthWithRole(["ADMIN"], async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end();
  }

  const buyId = Number.parseInt(String(req.query.id), 10);
  if (!Number.isInteger(buyId) || buyId <= 0) {
    return res.status(400).json({ error: "Invalid buyId" });
  }

  try {
    // 1. Drafts in this Buy. We need draft → fulfilledProductId for
    //    the join and draft → draftPoId for the 1:N rollup.
    const draftRows = await prisma.buyerDraftItem.findMany({
      where: {
        draftPo: { buyId },
      },
      select: {
        id: true,
        partNumber: true,
        productName: true,
        vendorName: true,
        fulfilledProductId: true,
        draftPoId: true,
      },
    });

    // 2. Draft POs for this Buy (for the per-draft-PO rollup view).
    //    Pull `expectedShipMonth` (for the date cutoff) + the
    //    `realPoLinks` (Slice 6.14 M:N join — drives the explicit-
    //    import precedence first introduced in Slice 6.13).
    const draftPoRows = await prisma.buyerDraftPurchaseOrder.findMany({
      where: { buyId },
      select: {
        id: true,
        vendorName: true,
        expectedShipMonth: true,
        realPoLinks: { select: { realPoId: true } },
      },
    });

    const linkedProductIds = draftRows
      .map((d) => d.fulfilledProductId)
      .filter((v): v is number => v !== null);

    // Explicit-link set (Slice 6.14, M:N). When ANY draft PO on the buy
    // has rows in BuyerDraftPoRealPoLink — whether AUTO (forward-flow
    // auto-link), MANUAL (operator clicked "link to existing"), or
    // HISTORICAL_IMPORT — those are AUTHORITATIVE. Empirical productId
    // join is skipped. Avoids the Spring 2026 noise where 54 PONs
    // surfaced because stocking SKUs had years of PO history.
    const explicitRealPoIds = new Set(
      draftPoRows.flatMap((p) => p.realPoLinks.map((l) => l.realPoId)),
    );

    // Slice 6.8.2 (2026-05-15) — bound the productId match by
    // orderDate. Without this, a product that has been on multiple
    // POs over the years pulls every historical PO into the linked
    // set, anchoring sales windows to ancient receivings unrelated
    // to this buy. Tightened 2026-05-22 in two passes after the
    // Spring 2026 audit: first 12 → 6 months, then 6 → 3 months.
    // Owner expectation: "for a Spring buy (Jan-Apr ETAs) I wouldn't
    // expect anything older than October 2025." October-market
    // writeups land ~3 months before the earliest January ETA.
    // Cutoff = earliest expectedShipMonth − 3 months, with fallback
    // to buy.created − 3 months. Skipped entirely when explicit
    // imports exist. Buys with unusually long lead times (custom
    // furniture, long-lead-time vendors) can override via the
    // Slice 6.13 explicit-import path — that's the safety valve.
    const buyRow = await prisma.buyerDraftBuy.findUnique({
      where: { id: buyId },
      select: { created: true },
    });
    const orderDateCutoff =
      explicitRealPoIds.size > 0
        ? null
        : computeBuyLinkCutoff(draftPoRows, buyRow?.created ?? new Date(), 3);

    // 3. Real PO lines that reference any of our linked Products,
    //    then the PurchaseOrders that own those lines, plus EVERY
    //    line on those POs (so we can report "matched lines / total
    //    lines" per PO accurately).
    let realPoLines: RealPoLineInput[] = [];
    let realPos: RealPoInput[] = [];
    if (explicitRealPoIds.size > 0) {
      // Authoritative path: pull EXACTLY the explicitly-imported PONs,
      // regardless of productId overlap. The helper's scope filter is
      // belt-and-suspenders.
      const realPoIds = Array.from(explicitRealPoIds);
      const [allLines, realPoRows] = await Promise.all([
        prisma.purchaseOrderItem.findMany({
          where: { purchaseOrderId: { in: realPoIds } },
          select: {
            purchaseOrderId: true,
            productId: true,
            orderedQuantity: true,
            partNo: true,
            productName: true,
            unitCost: true,
          },
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
        partNo: l.partNo,
        productName: l.productName,
        unitCost: l.unitCost == null ? null : Number(l.unitCost.toString()),
      }));
      realPos = realPoRows.map((p) => ({
        id: p.id,
        poNumber: p.poNumber,
        vendor: p.vendor?.name ?? "(unknown)",
        vendorId: p.vendor?.id ?? null,
        orderDate: p.orderDate,
        status: p.status,
      }));
    } else if (linkedProductIds.length > 0) {
      const matchingLines = await prisma.purchaseOrderItem.findMany({
        where: {
          productId: { in: linkedProductIds },
          purchaseOrder: orderDateCutoff ? { orderDate: { gte: orderDateCutoff } } : undefined,
        },
        select: { purchaseOrderId: true },
      });
      const realPoIds = [...new Set(matchingLines.map((l) => l.purchaseOrderId))];
      if (realPoIds.length > 0) {
        const [allLines, realPoRows] = await Promise.all([
          prisma.purchaseOrderItem.findMany({
            where: { purchaseOrderId: { in: realPoIds } },
            select: {
              purchaseOrderId: true,
              productId: true,
              orderedQuantity: true,
              partNo: true,
              productName: true,
              unitCost: true,
            },
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
          partNo: l.partNo,
          productName: l.productName,
          unitCost: l.unitCost == null ? null : Number(l.unitCost.toString()),
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

    const result = computeLinkedPos(drafts, draftPos, realPos, realPoLines, {
      explicitRealPoIds: explicitRealPoIds.size > 0 ? explicitRealPoIds : undefined,
      windowStart: orderDateCutoff,
    });

    // Vendor mismatch detection: compute the unique set of REAL
    // vendor names per draft PO (via productId → real PO → vendor),
    // then flag any where the draft's typed vendor name differs.
    // Surfaces cosmetic-but-noteworthy cases like Gat Creek / Caperton.
    const mismatchInputs: VendorMismatchInput[] = draftPoRows.map((draftPo) => {
      const childProductIds = draftRows
        .filter((d) => d.draftPoId === draftPo.id && d.fulfilledProductId !== null)
        .map((d) => d.fulfilledProductId as number);
      const realVendors = new Set<string>();
      for (const productId of childProductIds) {
        for (const line of realPoLines) {
          if (line.productId === productId) {
            const realPo = realPos.find((p) => p.id === line.realPoId);
            if (realPo) realVendors.add(realPo.vendor);
          }
        }
      }
      return {
        draftPoId: draftPo.id,
        draftVendorName: draftPo.vendorName,
        realVendorNames: [...realVendors],
      };
    });
    const vendorMismatches = detectVendorMismatches(mismatchInputs);

    return res.status(200).json({ ...result, vendorMismatches });
  } catch (err) {
    logError(`buyer-drafts buys/${buyId}/linked-pos failed`, err);
    return res.status(500).json({ error: "Failed to compute linked POs" });
  }
});
