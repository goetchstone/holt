// /app/src/pages/api/scan/transfer/send.ts
//
// GAP-19: send a transfer from the handheld (sendFromPlace,
// lib/inventory/transfers.ts). What was scanned leaves the place now and is
// on its way until it is scanned in at the other end (./receive.ts). The
// longer way is always allowed, so a move the places' mode would have let
// through as quick may still be sent. Done once per actionKey (withAction).
//
// POST { actionKey, fromStockLocationId, toLocationId, toStockLocationId?,
//        items: [{ productId, units }] }

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { InsufficientStockError, PlaceError } from "@/lib/inventory/ledger";
import {
  sendFromPlace,
  TransferPlaceError,
  TransferQuantityError,
  TransferShortError,
} from "@/lib/inventory/transfers";
import { ActionKeyError, parseActionKey, withAction } from "@/lib/inventory/withAction";
import { logError } from "@/lib/logger";

export async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const actionKey = parseActionKey(body.actionKey);
  if (actionKey instanceof ActionKeyError) {
    return res.status(400).json({ error: actionKey.message });
  }
  const from = Number(body.fromStockLocationId);
  const toLocationId = Number(body.toLocationId);
  const toStockLocationId = body.toStockLocationId ? Number(body.toStockLocationId) : null;
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(toLocationId) ||
    (toStockLocationId !== null && !Number.isInteger(toStockLocationId))
  ) {
    return res
      .status(400)
      .json({ error: "Scan the place it leaves from and choose the store it goes to." });
  }
  const items = Array.isArray(body.items)
    ? (body.items as { productId: unknown; units: unknown }[])
        .map((i) => ({ productId: Number(i.productId), quantity: Number(i.units) }))
        .filter((i) => Number.isInteger(i.productId) && i.quantity > 0)
    : [];
  if (items.length === 0) return res.status(400).json({ error: "Nothing to send." });
  const requestedByUserId = session.user?.id;
  if (!requestedByUserId) {
    return res.status(401).json({ error: "Sign in again: your session has no user id." });
  }
  const actor = session.user?.email || null;
  try {
    const { result, replayed } = await withAction(
      actionKey,
      { kind: "TRANSFER", actor },
      async (tx) => {
        const sent = await sendFromPlace(tx, {
          items,
          fromStockLocationId: from,
          toLocationId,
          toStockLocationId,
          requestedByUserId,
          actor,
          actionKey,
        });
        return {
          units: sent.reduce((s, t) => s + t.quantity, 0),
          transfers: sent.map((t) => t.id),
          committed: sent.filter((t) => t.salesOrderId != null).reduce((s, t) => s + t.quantity, 0),
        };
      },
    );
    return res.status(replayed ? 200 : 201).json({ ...result, replayed });
  } catch (error) {
    if (
      error instanceof TransferPlaceError ||
      error instanceof TransferQuantityError ||
      error instanceof PlaceError
    ) {
      return res.status(400).json({ error: error.message });
    }
    if (error instanceof TransferShortError || error instanceof InsufficientStockError) {
      return res.status(409).json({ error: error.message });
    }
    logError("Error sending a transfer from a handheld", error);
    return res.status(500).json({ error: "Failed to send the transfer" });
  }
}

export default requirePermission("inventory.transfer", handler);
