// /app/src/pages/api/admin/buyer-drafts/find-sibling-pos.ts
//
// Slice 6.13 followup (2026-05-22) — Find sibling PurchaseOrders after
// a historical PO import.
//
// Use case: the POS's partial-receive workflow creates a NEW PO for
// the un-received remainder (with no parent reference). The buyer
// reconstructing a buy might import the original PO but miss the
// remainder. This endpoint surfaces same-vendor + near-date + partNo-
// overlap candidates as "Also import?" suggestions.
//
// Scoring + ranking lives in `lib/historicalPoSiblings.ts` per CLAUDE.md
// rule 14. This handler is the thin Prisma + HTTP wrapper.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import { scoreSiblings, type SiblingCandidate } from "@/lib/historicalPoSiblings";

const WINDOW_DAYS = 90; // ± this many days from source PO's orderDate
const MAX_CANDIDATES = 10; // cap on suggestions surfaced to the modal

export default requireAuthWithRole(["ADMIN"], async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end();
  }

  const purchaseOrderId = Number.parseInt(String(req.query.purchaseOrderId ?? ""), 10);
  if (!Number.isInteger(purchaseOrderId) || purchaseOrderId <= 0) {
    return res.status(400).json({ error: "purchaseOrderId is required" });
  }

  try {
    // Load the source PO + its line item partNos.
    const source = await prisma.purchaseOrder.findUnique({
      where: { id: purchaseOrderId },
      select: {
        id: true,
        vendorId: true,
        orderDate: true,
        lineItems: { select: { partNo: true } },
      },
    });
    if (!source) {
      return res.status(404).json({ error: `PurchaseOrder ${purchaseOrderId} not found` });
    }

    const sourcePartNos = source.lineItems
      .map((li) => li.partNo)
      .filter((pn): pn is string => typeof pn === "string" && pn.length > 0);

    if (sourcePartNos.length === 0) {
      // Source has no usable partNos — overlap match impossible.
      return res.status(200).json({ suggestions: [] });
    }

    // Date window in ms
    const windowMs = WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const minDate = new Date(source.orderDate.getTime() - windowMs);
    const maxDate = new Date(source.orderDate.getTime() + windowMs);

    // Pull candidate POs: same vendor, near date, not cancelled, not self.
    const candidates = await prisma.purchaseOrder.findMany({
      where: {
        vendorId: source.vendorId,
        id: { not: source.id },
        status: { not: "CANCELLED" },
        orderDate: { gte: minDate, lte: maxDate },
      },
      select: {
        id: true,
        poNumber: true,
        orderDate: true,
        vendorId: true,
        vendor: { select: { name: true } },
        status: true,
        lineItems: { select: { partNo: true } },
        buyerDraftLink: { select: { draftPo: { select: { buyId: true } } } },
      },
      // Wide-but-bounded pool — the helper does final scoring.
      take: 200,
    });

    const hydrated: SiblingCandidate[] = candidates.map((po) => ({
      id: po.id,
      poNumber: po.poNumber,
      orderDate: po.orderDate,
      vendorId: po.vendorId,
      vendorName: po.vendor.name,
      status: po.status,
      lineCount: po.lineItems.length,
      partNos: po.lineItems
        .map((li) => li.partNo)
        .filter((pn): pn is string => typeof pn === "string" && pn.length > 0),
      alreadyImportedToBuyId: po.buyerDraftLink?.draftPo.buyId ?? null,
    }));

    const scored = scoreSiblings({ id: source.id, partNos: sourcePartNos }, hydrated);
    const top = scored.slice(0, MAX_CANDIDATES).map((s) => ({
      id: s.id,
      poNumber: s.poNumber,
      orderDate: s.orderDate.toISOString(),
      vendor: { id: s.vendorId, name: s.vendorName },
      status: s.status,
      lineCount: s.lineCount,
      overlapCount: s.overlapCount,
      fullyContainedBySource: s.fullyContainedBySource,
    }));

    return res.status(200).json({ suggestions: top });
  } catch (err) {
    logError("[buyer-drafts/find-sibling-pos] unexpected error", err);
    return res.status(500).json({ error: "Sibling lookup failed" });
  }
});
