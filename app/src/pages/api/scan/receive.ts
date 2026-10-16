// /app/src/pages/api/scan/receive.ts
//
// Receiving on a handheld (ledger plan phase 16), through the same function
// as the Receive PO screen (lib/purchasing/receivePurchaseOrder.ts).
//
// GET  ?po=<PO number or id>&storeLocationId=
//      the PO's lines (ordered, received so far, boxes per unit) and every
//      incomplete set waiting at the store for one of its products.
// POST { actionKey, purchaseOrderId, storeLocationId, toStockLocationId?,
//        lines: [{ purchaseOrderItemId, units, boxes: number[] }],
//        completeSets: [{ noteId, boxes: number[] }] }
//      `units` are whole units counted by product scan; `boxes` are box-label
//      scans, assembled into whole units and incomplete sets
//      (lib/inventory/boxes.ts). Done once per actionKey (withAction).

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { assembleUnits, BoxError } from "@/lib/inventory/boxes";
import { addBoxesToIncompleteSet, openBoxNotes } from "@/lib/inventory/boxNotes";
import { parseActionKey, withAction, ActionKeyError } from "@/lib/inventory/withAction";
import { receivePurchaseOrder, ReceiveError } from "@/lib/purchasing/receivePurchaseOrder";
import { LandingPlaceUnsetError } from "@/lib/inventory/places";
import { logError } from "@/lib/logger";

const OPEN_STATUSES = ["SUBMITTED", "CONFIRMED", "RECEIVED_PARTIAL", "DRAFT"] as const;

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const raw = typeof req.query.po === "string" ? req.query.po.trim() : "";
  const storeLocationId = Number(req.query.storeLocationId) || null;
  if (!raw) return res.status(400).json({ error: "po is required." });
  const asId = /^\d+$/.test(raw) ? Number(raw) : null;
  const po = await prisma.purchaseOrder.findFirst({
    where: {
      OR: [{ poNumber: { equals: raw, mode: "insensitive" } }, ...(asId ? [{ id: asId }] : [])],
    },
    select: {
      id: true,
      poNumber: true,
      status: true,
      vendor: { select: { name: true } },
      lineItems: {
        select: {
          id: true,
          productId: true,
          productName: true,
          partNo: true,
          orderedQuantity: true,
          product: { select: { name: true, productNumber: true, boxesPerUnit: true } },
          receivingRecords: { select: { quantityReceived: true } },
        },
        orderBy: { id: "asc" },
      },
    },
  });
  if (!po) return res.status(404).json({ error: `No purchase order ${raw}.` });
  const productIds = po.lineItems.map((l) => l.productId).filter((id): id is number => id != null);
  const sets = storeLocationId
    ? (await openBoxNotes(prisma, { storeLocationId, kind: "INCOMPLETE" })).filter((n) =>
        productIds.includes(n.productId),
      )
    : [];
  return res.status(200).json({
    po: {
      id: po.id,
      poNumber: po.poNumber,
      status: po.status,
      vendor: po.vendor.name,
      open: (OPEN_STATUSES as readonly string[]).includes(po.status),
    },
    lines: po.lineItems.map((l) => ({
      purchaseOrderItemId: l.id,
      productId: l.productId,
      productNumber: l.product?.productNumber ?? l.partNo ?? "",
      name: l.product?.name ?? l.productName ?? "",
      boxesPerUnit: Math.max(1, l.product?.boxesPerUnit ?? 1),
      ordered: Number(l.orderedQuantity),
      received: l.receivingRecords.reduce((s, r) => s + Number(r.quantityReceived), 0),
    })),
    incompleteSets: sets.map((n) => ({
      noteId: n.id,
      productId: n.productId,
      missing: n.boxes,
      fromThisPo: n.sourceType === "PurchaseOrder" && n.sourceId === po.id,
    })),
  });
}

interface PostLine {
  purchaseOrderItemId: number;
  units?: number;
  boxes?: number[];
}

async function handlePost(req: NextApiRequest, res: NextApiResponse, session: Session) {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const actionKey = parseActionKey(body.actionKey);
  if (actionKey instanceof ActionKeyError)
    return res.status(400).json({ error: actionKey.message });
  const purchaseOrderId = Number(body.purchaseOrderId);
  const storeLocationId = Number(body.storeLocationId);
  if (!Number.isInteger(purchaseOrderId) || !Number.isInteger(storeLocationId)) {
    return res.status(400).json({ error: "purchaseOrderId and storeLocationId are required." });
  }
  const receiverUserId = session.user?.id;
  if (!receiverUserId) {
    return res.status(401).json({ error: "Sign in again: your session has no user id." });
  }
  const toStockLocationId = body.toStockLocationId ? Number(body.toStockLocationId) : null;
  const lines = Array.isArray(body.lines) ? (body.lines as PostLine[]) : [];
  const completeSets = Array.isArray(body.completeSets)
    ? (body.completeSets as { noteId: number; boxes: number[] }[])
    : [];
  if (lines.length === 0 && completeSets.length === 0) {
    return res.status(400).json({ error: "Nothing was scanned." });
  }
  const actor = session.user?.email || null;

  const { result, replayed } = await withAction(
    actionKey,
    { kind: "RECEIVE", actor },
    async (tx) => {
      const poLines = await tx.purchaseOrderItem.findMany({
        where: { purchaseOrderId },
        select: { id: true, product: { select: { boxesPerUnit: true } } },
      });
      const boxesFor = new Map(
        poLines.map((l) => [l.id, Math.max(1, l.product?.boxesPerUnit ?? 1)]),
      );
      const items = lines
        .map((l) => {
          const boxes = Array.isArray(l.boxes) ? l.boxes.map(Number) : [];
          const assembled = assembleUnits(boxesFor.get(Number(l.purchaseOrderItemId)) ?? 1, boxes);
          return {
            purchaseOrderItemId: Number(l.purchaseOrderItemId),
            quantityReceived: (Number(l.units) || 0) + assembled.units,
            destinationStockLocationId: toStockLocationId,
            incompleteSets: assembled.incomplete.map((s) => ({ missing: s.missing })),
          };
        })
        .filter((i) => i.quantityReceived > 0 || i.incompleteSets.length > 0);
      const received = items.length
        ? await receivePurchaseOrder(tx, {
            poId: purchaseOrderId,
            storeLocationId,
            items,
            receiverUserId,
            actor,
            actionKey,
          })
        : null;
      const completed: number[] = [];
      for (const c of completeSets) {
        const r = await addBoxesToIncompleteSet(tx, {
          noteId: Number(c.noteId),
          boxes: (c.boxes ?? []).map(Number),
          storeLocationId,
          toStockLocationId,
          actor,
          actionKey,
        });
        if (r.completed) completed.push(Number(c.noteId));
      }
      return {
        units: items.reduce((s, i) => s + i.quantityReceived, 0),
        incompleteSets: received?.incompleteNotes.length ?? 0,
        completedSets: completed.length,
        newStatus: received?.newStatus ?? null,
      };
    },
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
    if (error instanceof ReceiveError)
      return res.status(error.status).json({ error: error.message });
    if (error instanceof BoxError || error instanceof LandingPlaceUnsetError) {
      return res.status(400).json({ error: error.message });
    }
    logError("Error receiving on a handheld", error);
    return res.status(500).json({ error: "Failed to receive" });
  }
}

export default requirePermission("purchasing.receive", handler);
