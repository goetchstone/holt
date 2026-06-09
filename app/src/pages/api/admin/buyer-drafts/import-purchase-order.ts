// /app/src/pages/api/admin/buyer-drafts/import-purchase-order.ts
//
// Slice 6.13 (2026-05-22) — Import an existing PurchaseOrder into a
// BuyerDraftBuy. Creates one BuyerDraftPurchaseOrder + N BuyerDraftItem
// rows in a single transaction. Idempotent: rejects with 409 when the
// source PO has already been imported (the @unique FK enforces this at
// the schema level, but we surface a friendly response shape so the UI
// can show "already imported into [buy name]" without parsing Prisma
// error codes).
//
// Pure shape-construction lives in `lib/historicalPoImport.ts`; this
// handler is the I/O + transaction wrapper per CLAUDE.md rule 14.
//
// ADMIN-only.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import {
  buildImportFromPurchaseOrder,
  type PurchaseOrderForImport,
} from "@/lib/historicalPoImport";

interface RequestBody {
  buyId?: number;
  purchaseOrderId?: number;
}

export default requireAuthWithRole(["ADMIN"], async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end();
  }

  const body = req.body as RequestBody;
  const buyId = Number.parseInt(String(body.buyId ?? ""), 10);
  const purchaseOrderId = Number.parseInt(String(body.purchaseOrderId ?? ""), 10);
  if (!Number.isInteger(buyId) || buyId <= 0) {
    return res.status(400).json({ error: "buyId is required" });
  }
  if (!Number.isInteger(purchaseOrderId) || purchaseOrderId <= 0) {
    return res.status(400).json({ error: "purchaseOrderId is required" });
  }

  const userEmail = (req as unknown as { user?: { email?: string } }).user?.email ?? null;

  try {
    // Pre-flight: is this PO already linked to a draft PO anywhere?
    // Single indexed lookup against BuyerDraftPoRealPoLink.realPoId
    // (@unique). Same idempotency invariant as before — just queried
    // against the join table now that we're M:N (Slice 6.14).
    const existing = await prisma.buyerDraftPoRealPoLink.findUnique({
      where: { realPoId: purchaseOrderId },
      select: {
        draftPo: {
          select: { id: true, buyId: true, buy: { select: { id: true, name: true } } },
        },
      },
    });
    if (existing) {
      return res.status(409).json({
        error: "This purchase order has already been linked to a draft PO.",
        alreadyImported: {
          draftPoId: existing.draftPo.id,
          buyId: existing.draftPo.buyId ?? null,
          buyName: existing.draftPo.buy?.name ?? null,
        },
      });
    }

    // Verify the buy exists.
    const buy = await prisma.buyerDraftBuy.findUnique({
      where: { id: buyId },
      select: { id: true, name: true },
    });
    if (!buy) {
      return res.status(404).json({ error: `BuyerDraftBuy ${buyId} not found` });
    }

    // Hydrate the real PO + line items + linked Products.
    const po = await prisma.purchaseOrder.findUnique({
      where: { id: purchaseOrderId },
      select: {
        id: true,
        poNumber: true,
        vendorId: true,
        vendor: { select: { name: true } },
        orderDate: true,
        expectedDelivery: true,
        estimatedShipDate: true,
        status: true,
        notes: true,
        lineItems: {
          select: {
            id: true,
            productId: true,
            orderedQuantity: true,
            unitCost: true,
            partNo: true,
            productName: true,
            product: {
              select: { id: true, productNumber: true, name: true, baseRetail: true },
            },
          },
        },
      },
    });
    if (!po) {
      return res.status(404).json({ error: `PurchaseOrder ${purchaseOrderId} not found` });
    }
    if (po.status === "CANCELLED") {
      return res
        .status(400)
        .json({ error: "Cannot import a CANCELLED purchase order — restore it first." });
    }

    // Build the create shapes.
    const built = buildImportFromPurchaseOrder(po as unknown as PurchaseOrderForImport);

    // Single transaction: create the draft PO + every draft item + the
    // join-table row to the real PO (Slice 6.14 M:N).
    const result = await prisma.$transaction(async (tx) => {
      const createdDraftPo = await tx.buyerDraftPurchaseOrder.create({
        data: {
          ...built.draftPo,
          buyId,
          createdBy: userEmail,
          updatedBy: userEmail,
        },
        select: { id: true },
      });
      if (built.draftItems.length > 0) {
        await tx.buyerDraftItem.createMany({
          data: built.draftItems.map((item) => ({
            ...item,
            draftPoId: createdDraftPo.id,
            createdBy: userEmail,
            updatedBy: userEmail,
          })),
        });
      }
      await tx.buyerDraftPoRealPoLink.create({
        data: {
          draftPoId: createdDraftPo.id,
          realPoId: built.realPoIdForLink,
          linkSource: "HISTORICAL_IMPORT",
          createdBy: userEmail,
          updatedBy: userEmail,
        },
      });
      return { draftPoId: createdDraftPo.id };
    });

    return res.status(201).json({
      draftPoId: result.draftPoId,
      buyId,
      buyName: buy.name,
      purchaseOrderId,
      poNumber: po.poNumber,
      itemsImported: built.draftItems.length,
      skipped: built.skipped,
    });
  } catch (err) {
    logError("[buyer-drafts/import-purchase-order] unexpected error", err);
    return res.status(500).json({ error: "Import failed" });
  }
});
