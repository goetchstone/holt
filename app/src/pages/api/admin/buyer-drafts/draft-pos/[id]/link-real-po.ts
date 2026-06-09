// /app/src/pages/api/admin/buyer-drafts/draft-pos/[id]/link-real-po.ts
//
// Slice 6.14 (2026-05-22) — Manually attach a real PurchaseOrder to an
// existing BuyerDraftPurchaseOrder. Used when:
//   - the auto-link sweep didn't find the match (ambiguous candidates,
//     vendor name typo, etc.)
//   - the operator wants to add a partial-receive remainder PON to the
//     same draft PO as the original
//   - the operator is reconstructing a historical buy and wants to use
//     the existing forward-flow draft PO structure rather than creating
//     new draft POs via the Slice 6.13 import modal
//
// POST body: { realPoId: number }
// Response 201: { draftPoId, realPoId, linkSource: "MANUAL" }
// Response 409: real PO is already linked elsewhere
// Response 404: draft PO or real PO not found
//
// ADMIN-only.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

interface RequestBody {
  realPoId?: number;
}

export default requireAuthWithRole(["ADMIN"], async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }

  const draftPoId = Number.parseInt(String(req.query.id ?? ""), 10);
  if (!Number.isInteger(draftPoId) || draftPoId <= 0) {
    return res.status(400).json({ error: "Invalid draftPoId" });
  }
  const body = req.body as RequestBody;
  const realPoId = Number.parseInt(String(body.realPoId ?? ""), 10);
  if (!Number.isInteger(realPoId) || realPoId <= 0) {
    return res.status(400).json({ error: "realPoId is required" });
  }

  const userEmail = (req as unknown as { user?: { email?: string } }).user?.email ?? null;

  try {
    // Verify both sides exist.
    const [draftPo, realPo] = await Promise.all([
      prisma.buyerDraftPurchaseOrder.findUnique({
        where: { id: draftPoId },
        select: { id: true, buyId: true, vendorId: true },
      }),
      prisma.purchaseOrder.findUnique({
        where: { id: realPoId },
        select: { id: true, status: true, vendorId: true, poNumber: true },
      }),
    ]);
    if (!draftPo) {
      return res.status(404).json({ error: `BuyerDraftPurchaseOrder ${draftPoId} not found` });
    }
    if (!realPo) {
      return res.status(404).json({ error: `PurchaseOrder ${realPoId} not found` });
    }
    if (realPo.status === "CANCELLED") {
      return res.status(400).json({ error: "Cannot link a CANCELLED purchase order." });
    }

    // Pre-flight idempotency check on @unique realPoId.
    const existing = await prisma.buyerDraftPoRealPoLink.findUnique({
      where: { realPoId },
      select: {
        draftPoId: true,
        draftPo: { select: { id: true, buyId: true, buy: { select: { name: true } } } },
      },
    });
    if (existing) {
      if (existing.draftPoId === draftPoId) {
        // Already linked to THIS draft PO — idempotent no-op.
        return res
          .status(200)
          .json({ draftPoId, realPoId, linkSource: "MANUAL", alreadyLinked: true });
      }
      return res.status(409).json({
        error: "This purchase order is already linked to another draft PO.",
        alreadyImported: {
          draftPoId: existing.draftPoId,
          buyId: existing.draftPo.buyId ?? null,
          buyName: existing.draftPo.buy?.name ?? null,
        },
      });
    }

    // Soft warning: vendor mismatch is cosmetic (the linked-PO panel
    // surfaces it via `detectVendorMismatches`) but we still allow
    // the link. Logging it here makes audits easier.
    if (
      draftPo.vendorId !== null &&
      realPo.vendorId !== null &&
      draftPo.vendorId !== realPo.vendorId
    ) {
      logError(
        `[draft-pos/link-real-po] vendor mismatch on manual link: draftPoId=${draftPoId} vendorId=${draftPo.vendorId} vs realPoId=${realPoId} vendorId=${realPo.vendorId}`,
        undefined,
      );
    }

    await prisma.buyerDraftPoRealPoLink.create({
      data: {
        draftPoId,
        realPoId,
        linkSource: "MANUAL",
        createdBy: userEmail,
        updatedBy: userEmail,
      },
    });

    return res.status(201).json({
      draftPoId,
      realPoId,
      poNumber: realPo.poNumber,
      linkSource: "MANUAL",
    });
  } catch (err) {
    logError("[draft-pos/link-real-po] unexpected error", err);
    return res.status(500).json({ error: "Link failed" });
  }
});
