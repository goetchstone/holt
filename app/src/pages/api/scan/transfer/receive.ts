// /app/src/pages/api/scan/transfer/receive.ts
//
// GAP-19: receive transfers on the handheld (receiveArrivals,
// lib/inventory/transfers.ts). What is scanned at a store is received against
// the transfers on their way to it, through the same claim as the desk's
// receipt (claimAndReceive). Done once per actionKey (withAction).
//
// GET  ?storeLocationId=  what is on its way to that store, oldest first.
// POST { actionKey, storeLocationId, toStockLocationId?,
//        items: [{ productId, units }] }
//      units are whole units: the page assembles box labels into them.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { InsufficientStockError, PlaceError } from "@/lib/inventory/ledger";
import { roundQty, toQty } from "@/lib/inventory/quantity";
import {
  receiveArrivals,
  TransferPlaceError,
  TransferQuantityError,
  TransferRaceError,
  TransferShortError,
} from "@/lib/inventory/transfers";
import { ActionKeyError, parseActionKey, withAction } from "@/lib/inventory/withAction";
import type { OnItsWay } from "@/lib/inventory/transfersShared";
import { logError } from "@/lib/logger";

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const storeLocationId = Number(req.query.storeLocationId);
  if (!Number.isInteger(storeLocationId)) {
    return res.status(400).json({ error: "Choose the store first." });
  }
  const rows = await prisma.inventoryTransfer.findMany({
    where: { status: "IN_TRANSIT", toLocationId: storeLocationId },
    orderBy: { id: "asc" },
    select: {
      id: true,
      productId: true,
      quantity: true,
      receivedQuantity: true,
      fromLocation: true,
      product: { select: { name: true, productNumber: true, boxesPerUnit: true } },
      fromStoreLocation: { select: { name: true } },
      toStockLocation: { select: { name: true } },
      salesOrder: { select: { orderno: true } },
    },
  });
  const transfers: OnItsWay[] = rows.map((t) => ({
    id: t.id,
    productId: t.productId,
    productNumber: t.product.productNumber,
    name: t.product.name,
    boxesPerUnit: Math.max(1, t.product.boxesPerUnit ?? 1),
    from: t.fromStoreLocation?.name ?? t.fromLocation,
    remaining: roundQty(toQty(t.quantity) - toQty(t.receivedQuantity)),
    toPlace: t.toStockLocation?.name ?? null,
    orderNo: t.salesOrder?.orderno ?? null,
  }));
  return res.status(200).json({ transfers });
}

async function handlePost(req: NextApiRequest, res: NextApiResponse, session: Session) {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const actionKey = parseActionKey(body.actionKey);
  if (actionKey instanceof ActionKeyError) {
    return res.status(400).json({ error: actionKey.message });
  }
  const storeLocationId = Number(body.storeLocationId);
  const toStockLocationId = body.toStockLocationId ? Number(body.toStockLocationId) : null;
  if (
    !Number.isInteger(storeLocationId) ||
    (toStockLocationId !== null && !Number.isInteger(toStockLocationId))
  ) {
    return res.status(400).json({ error: "Choose the store first." });
  }
  const items = Array.isArray(body.items)
    ? (body.items as { productId: unknown; units: unknown }[])
        .map((i) => ({ productId: Number(i.productId), units: Number(i.units) }))
        .filter((i) => Number.isInteger(i.productId) && i.units > 0)
    : [];
  if (items.length === 0) return res.status(400).json({ error: "Nothing was scanned." });
  const actor = session.user?.email || null;
  const { result, replayed } = await withAction(
    actionKey,
    { kind: "TRANSFER_RECEIVE", actor },
    (tx) => receiveArrivals(tx, { storeLocationId, toStockLocationId, items, actor, actionKey }),
  );
  return res.status(replayed ? 200 : 201).json({ ...result, replayed });
}

export async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  try {
    if (req.method === "GET") return await handleGet(req, res);
    if (req.method === "POST") return await handlePost(req, res, session);
    res.setHeader("Allow", ["GET", "POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    if (
      error instanceof TransferPlaceError ||
      error instanceof TransferQuantityError ||
      error instanceof PlaceError
    ) {
      return res.status(400).json({ error: error.message });
    }
    if (
      error instanceof TransferRaceError ||
      error instanceof TransferShortError ||
      error instanceof InsufficientStockError
    ) {
      return res.status(409).json({ error: error.message });
    }
    logError("Error receiving a transfer on a handheld", error);
    return res.status(500).json({ error: "Failed to receive" });
  }
}

export default requirePermission("inventory.transfer", handler);
