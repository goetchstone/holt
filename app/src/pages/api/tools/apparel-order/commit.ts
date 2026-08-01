// /app/src/pages/api/tools/apparel-order/commit.ts
//
// Creates the Buyer Drafts DB rows for one Apparel Order Import run: one
// BuyerDraftPurchaseOrder + one BuyerDraftItem per reviewed row, in a
// single transaction. This is holt's equivalent of FC's apparel-order
// tool "download the Ordorite CSVs" step -- holt is its own system of
// record for buyer drafts, so the tool writes DB rows instead of a file.
// From here the buyer uses the existing Buyer Drafts workbench
// (/app/admin/buyer-drafts) to curate, and the existing export endpoints
// (export/items, export/pos, export/workbook) to hand off to the POS
// exactly like any other draft.
//
// Pure shape-construction lives in `lib/apparelOrderToBuyerDraft.ts`; this
// handler is the thin I/O + transaction wrapper per CLAUDE.md rule 14.
//
// ADMIN-only (mirrors the buyer-drafts/* admin endpoints -- the domain
// this tool feeds is ADMIN-only per docs/domains/buyer-drafts.md).

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import { buildItemCreateData, buildPoCreateData } from "@/lib/buyerDraftRequestBody";
import {
  buildApparelDraftPoBody,
  buildApparelDraftItemBodies,
  type ApparelDraftPoOptions,
  type ApparelDraftItemOptions,
} from "@/lib/apparelOrderToBuyerDraft";
import type { ApparelOrderDraft, ApparelOrderRow } from "@/lib/apparelOrderVendors";

interface ApparelOrderCommitBody {
  draft?: Pick<
    ApparelOrderDraft,
    "vendorName" | "poNumber" | "orderNumber" | "orderDate" | "season" | "warnings"
  >;
  rows?: ApparelOrderRow[];
  po?: Partial<ApparelDraftPoOptions>;
  item?: Partial<ApparelDraftItemOptions>;
}

function isFiniteRow(row: unknown): row is ApparelOrderRow {
  if (!row || typeof row !== "object") return false;
  const r = row as Partial<ApparelOrderRow>;
  return (
    typeof r.partNumber === "string" &&
    r.partNumber.trim() !== "" &&
    typeof r.productName === "string" &&
    typeof r.qty === "number" &&
    Number.isFinite(r.qty)
  );
}

export default requireAuthWithRole(
  ["ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method !== "POST") {
      res.setHeader("Allow", ["POST"]);
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = req.body as ApparelOrderCommitBody;
    const draft = body.draft;
    const rows = body.rows;

    if (!draft) {
      return res.status(400).json({ error: "draft is required" });
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: "rows must be a non-empty array" });
    }
    const badIndex = rows.findIndex((r) => !isFiniteRow(r));
    if (badIndex !== -1) {
      return res.status(400).json({
        error: `rows[${badIndex}] is missing partNumber / productName / qty`,
      });
    }

    const poOptions: ApparelDraftPoOptions = {
      vendorId: body.po?.vendorId ?? null,
      vendorName: body.po?.vendorName,
      referenceNumber: body.po?.referenceNumber ?? null,
      expectedShipMonth: body.po?.expectedShipMonth ?? null,
      expectedDeliveryDate: body.po?.expectedDeliveryDate ?? null,
      storeLocationId: body.po?.storeLocationId ?? null,
      buyId: body.po?.buyId ?? null,
    };
    const itemOptions: ApparelDraftItemOptions = {
      vendorId: body.item?.vendorId ?? poOptions.vendorId,
      departmentId: body.item?.departmentId ?? null,
      categoryId: body.item?.categoryId ?? null,
      stockLocationId: body.item?.stockLocationId ?? null,
      stockProgram: body.item?.stockProgram ?? false,
    };

    const createdBy = session.user?.email ?? null;

    let poCreateInput;
    let itemCreateInputs;
    try {
      const poBody = buildApparelDraftPoBody(draft as ApparelOrderDraft, poOptions);
      poCreateInput = buildPoCreateData(poBody, createdBy);

      // draftPoId is unknown until the PO is created below -- pass null
      // here and let each row's create body take the connect below via
      // draftPoId: created.id (buildItemCreateData reads body.draftPoId
      // directly as an FK id, not a connect, so we can inject it after
      // building each row's body).
      const itemBodies = buildApparelDraftItemBodies(rows, null, itemOptions);
      itemCreateInputs = itemBodies.map((itemBody) => buildItemCreateData(itemBody, createdBy));
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : "Invalid body" });
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        const createdPo = await tx.buyerDraftPurchaseOrder.create({
          data: poCreateInput,
          select: { id: true, referenceNumber: true, vendorName: true },
        });
        await tx.buyerDraftItem.createMany({
          data: itemCreateInputs.map((item) => ({ ...item, draftPoId: createdPo.id })),
        });
        return createdPo;
      });

      return res.status(201).json({
        po: result,
        itemCount: itemCreateInputs.length,
      });
    } catch (err) {
      logError("Apparel order commit failed", err);
      return res.status(500).json({ error: "Failed to create draft PO + items" });
    }
  },
);
