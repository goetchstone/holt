// /app/src/pages/api/scan/order.ts
//
// GAP-19: a reorder scanned on the handheld (lib/purchasing/scannedOrder.ts).
// On "Write purchase orders", the key a PO written at the desk takes. It reads
// its own scans rather than asking /api/scan/resolve, so a role that writes
// POs without reading inventory can still use it.
//
// GET  ?code=<scanned text>&storeLocationId=
//      the item scanned and the vendors it can be ordered from, its own first,
//      or why it can't be ordered.
// POST { actionKey, shipToLocationId, lines: [{ productId, vendorId, quantity }] }
//      files the lines on each vendor's open draft for the store, or a new
//      draft. Done once per actionKey (withAction).

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { parseQty } from "@/lib/inventory/qtyInput";
import { ActionKeyError, parseActionKey } from "@/lib/inventory/withAction";
import { resolveScan } from "@/lib/scan/resolveScan";
import { orderableItem, saveScannedOrder } from "@/lib/purchasing/scannedOrder";
import type { ScannedLine } from "@/lib/purchasing/purchaseOrderShared";
import { PurchaseOrderError } from "@/lib/purchasing/stockPurchaseOrder";
import { logError } from "@/lib/logger";

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  if (!code.trim()) return res.status(400).json({ error: "code is required." });
  const storeLocationId = Number(req.query.storeLocationId) || null;
  const scan = await resolveScan(prisma, code, { storeLocationId });
  if (scan.kind === "unknown") return res.status(404).json({ error: scan.message });
  if (scan.kind === "place") {
    return res.status(400).json({ error: `${scan.place.path} is a place: scan an item.` });
  }
  const item = await orderableItem(prisma, scan.product.id);
  if ("problem" in item) return res.status(400).json({ error: item.problem });
  return res.status(200).json(item);
}

/** The lines sent, or null when any is missing a product, a vendor or a quantity above zero. */
function parseLines(raw: unknown): ScannedLine[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const lines: ScannedLine[] = [];
  for (const l of raw as Record<string, unknown>[]) {
    const productId = Number(l?.productId);
    const vendorId = Number(l?.vendorId);
    const quantity = parseQty(l?.quantity);
    if (!Number.isInteger(productId) || !Number.isInteger(vendorId) || quantity == null) {
      return null;
    }
    lines.push({ productId, vendorId, quantity });
  }
  return lines;
}

async function handlePost(req: NextApiRequest, res: NextApiResponse, session: Session) {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const actionKey = parseActionKey(body.actionKey);
  if (actionKey instanceof ActionKeyError) {
    return res.status(400).json({ error: actionKey.message });
  }
  const shipToLocationId = Number(body.shipToLocationId);
  if (!Number.isInteger(shipToLocationId)) {
    return res.status(400).json({ error: "Choose the store the order is for." });
  }
  const lines = parseLines(body.lines);
  if (!lines) {
    return res
      .status(400)
      .json({ error: "Each line needs an item, a vendor and a quantity above zero." });
  }
  const { result, replayed } = await saveScannedOrder(
    actionKey,
    { shipToLocationId, lines },
    session.user?.email || null,
  );
  return res.status(replayed ? 200 : 201).json({ pos: result, replayed });
}

export async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  try {
    if (req.method === "GET") return await handleGet(req, res);
    if (req.method === "POST") return await handlePost(req, res, session);
    res.setHeader("Allow", ["GET", "POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    if (error instanceof PurchaseOrderError) {
      return res.status(error.status).json({ error: error.message });
    }
    logError("Error ordering on a handheld", error);
    return res.status(500).json({ error: "Failed to save the order" });
  }
}

export default requirePermission("purchasing.write", handler);
