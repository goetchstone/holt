// /app/src/pages/api/scan/move.ts
//
// Put away and move on a handheld (lib/inventory/floorMove.ts): units from
// one place to another now, and boxes moved on their own as stray-box notes.
// Done once per actionKey (withAction).
//
// POST { actionKey, fromStockLocationId, toStockLocationId,
//        items: [{ productId, units }], strayBoxes: [{ productId, boxes }] }

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { FloorMoveError, moveStrayBoxes, moveUnits } from "@/lib/inventory/floorMove";
import { MoveModeError } from "@/lib/inventory/transfers";
import { InsufficientStockError } from "@/lib/inventory/ledger";
import { ActionKeyError, parseActionKey, withAction } from "@/lib/inventory/withAction";
import { logError } from "@/lib/logger";

export async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const actionKey = parseActionKey(body.actionKey);
  if (actionKey instanceof ActionKeyError)
    return res.status(400).json({ error: actionKey.message });
  const from = Number(body.fromStockLocationId);
  const to = Number(body.toStockLocationId);
  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    return res
      .status(400)
      .json({ error: "fromStockLocationId and toStockLocationId are required." });
  }
  const items = Array.isArray(body.items)
    ? (body.items as { productId: unknown; units: unknown }[])
        .map((i) => ({ productId: Number(i.productId), units: Number(i.units) }))
        .filter((i) => i.units > 0)
    : [];
  const strays = Array.isArray(body.strayBoxes)
    ? (body.strayBoxes as { productId: unknown; boxes: unknown }[]).map((s) => ({
        productId: Number(s.productId),
        boxes: Array.isArray(s.boxes) ? s.boxes.map(Number) : [],
      }))
    : [];
  if (items.length === 0 && strays.every((s) => s.boxes.length === 0)) {
    return res.status(400).json({ error: "Nothing to move." });
  }
  const actor = session.user?.email || null;
  try {
    const { result, replayed } = await withAction(
      actionKey,
      { kind: "MOVE", actor },
      async (tx) => {
        let units = 0;
        let committed = 0;
        for (const i of items) {
          const r = await moveUnits(tx, {
            productId: i.productId,
            quantity: i.units,
            fromStockLocationId: from,
            toStockLocationId: to,
            actor,
            actionKey,
          });
          units += r.moved;
          committed += r.committedMoved;
        }
        let strayNotes = 0;
        let reunited = 0;
        for (const s of strays) {
          const product = await tx.product.findUnique({
            where: { id: s.productId },
            select: { boxesPerUnit: true },
          });
          const r = await moveStrayBoxes(tx, {
            productId: s.productId,
            boxes: s.boxes,
            boxesPerUnit: product?.boxesPerUnit ?? 1,
            fromStockLocationId: from,
            toStockLocationId: to,
            actor,
          });
          if (r.reunited) reunited++;
          if (r.noteId) strayNotes++;
        }
        return { units, committed, strayNotes, reunited };
      },
    );
    return res.status(replayed ? 200 : 201).json({ ...result, replayed });
  } catch (error) {
    if (error instanceof MoveModeError) {
      return res.status(400).json({
        error:
          "Moves between these places are tracked: start a transfer for it (Warehouse › Transfers).",
      });
    }
    if (error instanceof FloorMoveError || error instanceof InsufficientStockError) {
      return res.status(400).json({ error: error.message });
    }
    logError("Error moving stock on a handheld", error);
    return res.status(500).json({ error: "Failed to move" });
  }
}

export default requirePermission("inventory.transfer", handler);
