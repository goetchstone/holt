// /app/src/pages/api/tools/home-accessory-order/commit.ts
//
// Create the BuyerDraftPurchaseOrder(s) + BuyerDraftItem rows for a
// reviewed Home Accessory Order Import preview. This is the tool's "KEY
// ADAPTATION" from FC: FC's version of this page downloaded Ordorite CSVs
// here (files-only, no DB writes); holt writes real Buyer Drafts rows
// instead, using the SAME field-coercion contract
// (buildPoCreateData / buildItemCreateData in lib/buyerDraftRequestBody.ts)
// the buyer-drafts admin CRUD endpoints already use.
//
// One BuyerDraftPurchaseOrder is created per distinct order reference (a
// multi-order vendor bundle — e.g. a K&K PDF carrying two orders — creates
// two draft POs, "multi-PO bundles"). Every composed row becomes exactly
// one BuyerDraftItem, whether or not it landed on a draft PO (a
// buyer-excluded row is still created, just unassigned).
//
// ADMIN-only, matching the buyer-drafts admin endpoints. POST only.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import { buildItemCreateData, buildPoCreateData } from "@/lib/buyerDraftRequestBody";
import {
  buildHomeAccessoryItemCreateBody,
  buildHomeAccessoryPoCreateBody,
  groupRowsByReference,
  unassignedRows,
  type HomeAccessoryCommitContext,
} from "@/lib/homeAccessoryBuyerDraftMapping";
import type { EffectiveRow } from "@/lib/homeAccessoryRows";

interface CommitBody {
  supplier?: unknown;
  vendorId?: unknown;
  stockLocationId?: unknown;
  buyId?: unknown;
  requiredDateByReference?: unknown;
  rows?: unknown;
}

function asOptionalInt(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

export default requireAuthWithRole(["ADMIN"], async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body as CommitBody;
  const supplier = typeof body.supplier === "string" ? body.supplier.trim() : "";
  if (!supplier) {
    return res.status(400).json({ error: "supplier is required" });
  }
  const rows = Array.isArray(body.rows) ? (body.rows as EffectiveRow[]) : [];
  if (rows.length === 0) {
    return res
      .status(400)
      .json({ error: "No rows to create — nothing was parsed or every row was removed" });
  }
  const requiredDateByReference =
    body.requiredDateByReference && typeof body.requiredDateByReference === "object"
      ? (body.requiredDateByReference as Record<string, string>)
      : undefined;

  const ctx: HomeAccessoryCommitContext = {
    vendorId: asOptionalInt(body.vendorId),
    vendorName: supplier,
    stockLocationId: asOptionalInt(body.stockLocationId),
    buyId: asOptionalInt(body.buyId),
    requiredDateByReference,
    sourceLabel: `Home Accessory Order Import — ${supplier}`,
  };

  const groups = groupRowsByReference(rows);
  const unassigned = unassignedRows(rows);
  const createdBy = req.headers["x-holt-user"]?.toString() ?? null;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const createdPos: { id: number; referenceNumber: string | null }[] = [];
      let itemsCreated = 0;

      for (const group of groups) {
        const poData = buildPoCreateData(buildHomeAccessoryPoCreateBody(group, ctx), createdBy);
        const po = await tx.buyerDraftPurchaseOrder.create({ data: poData });
        createdPos.push({ id: po.id, referenceNumber: po.referenceNumber });

        for (const row of group.rows) {
          const itemData = buildItemCreateData(
            buildHomeAccessoryItemCreateBody(row, po.id, ctx),
            createdBy,
          );
          await tx.buyerDraftItem.create({ data: itemData });
          itemsCreated++;
        }
      }

      for (const row of unassigned) {
        const itemData = buildItemCreateData(
          buildHomeAccessoryItemCreateBody(row, null, ctx),
          createdBy,
        );
        await tx.buyerDraftItem.create({ data: itemData });
        itemsCreated++;
      }

      return { createdPos, itemsCreated };
    });

    return res.status(201).json({
      poCount: result.createdPos.length,
      pos: result.createdPos,
      itemCount: result.itemsCreated,
      unassignedCount: unassigned.length,
    });
  } catch (err) {
    if (err instanceof TypeError) {
      // Thrown by buildItemCreateData / buildPoCreateData on a
      // required-field violation (e.g. a row somehow missing partNumber
      // or productName) — map to a 400 same as the buyer-drafts CRUD
      // endpoints do.
      return res.status(400).json({ error: err.message });
    }
    logError("Home accessory order commit failed", err);
    return res.status(500).json({ error: "Failed to create draft PO(s) and items" });
  }
});
