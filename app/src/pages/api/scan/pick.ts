// /app/src/pages/api/scan/pick.ts
//
// Pick and load a delivery run on a handheld (lib/fulfilment/pick.ts).
//
// GET                    the runs to pick: planning or loaded, from yesterday on,
//                        and any run whose truck still carries stock.
// GET  ?runId=           the run's pull list: what is still to pull, where it
//                        is, stray boxes of those products, and what is on
//                        the run's truck (lib/fulfilment/truck.ts).
// POST { actionKey, deliveryRunId, salesOrderId, productId, units,
//        fromStockLocationId, toStockLocationId, boxes? }    pick
// POST { actionKey, deliveryRunId, load: true }            load the run
// POST { actionKey, deliveryRunId, unload: true, toStockLocationId }
//                        unload the truck to a loading bay

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import type { Prisma } from "@prisma/client";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { buildPullList } from "@/lib/fulfilment/pullList";
import { loadRun, pickUnits, PickError } from "@/lib/fulfilment/pick";
import { aboard, TruckError, unloadRun } from "@/lib/fulfilment/truck";
import { placePath } from "@/lib/inventory/placeTree";
import { BoxError } from "@/lib/inventory/boxes";
import { MoveModeError } from "@/lib/inventory/transfers";
import { ActionKeyError, parseActionKey, withAction } from "@/lib/inventory/withAction";
import { logError } from "@/lib/logger";

async function listRuns(res: NextApiResponse) {
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const runs = await prisma.deliveryRun.findMany({
    where: {
      OR: [
        { status: { in: ["PLANNING", "LOADED"] }, runDate: { gte: since } },
        // A truck back from its run, still carrying what could not be delivered.
        {
          status: { not: "COMPLETED" },
          truckPlaces: { some: { inventoryPositions: { some: {} } } },
        },
      ],
    },
    orderBy: { runDate: "asc" },
    take: 30,
    select: {
      id: true,
      runNumber: true,
      runDate: true,
      status: true,
      _count: { select: { stops: true } },
    },
  });
  return res.status(200).json({
    runs: runs.map((r) => ({
      id: r.id,
      runNumber: r.runNumber,
      runDate: r.runDate,
      status: r.status,
      stops: r._count.stops,
    })),
  });
}

async function runPull(res: NextApiResponse, runId: number) {
  const run = await prisma.deliveryRun.findUnique({
    where: { id: runId },
    select: { id: true, runNumber: true, runDate: true, status: true },
  });
  if (!run) return res.status(404).json({ error: "Run not found" });
  const [{ rows, notes }, onTruck] = await Promise.all([
    buildPullList(prisma, { deliveryRunId: runId }),
    aboard(prisma, runId),
  ]);
  const productIds = [...new Set(rows.map((r) => r.productId))];
  const orderIds = [...new Set(rows.map((r) => r.salesOrderId))];
  const placeIds = [
    ...new Set(rows.map((r) => r.fromStockLocationId).filter((id): id is number => id != null)),
  ];
  const [products, orders, places, strays] = await Promise.all([
    prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, name: true, productNumber: true, boxesPerUnit: true },
    }),
    prisma.salesOrder.findMany({
      where: { id: { in: orderIds } },
      select: { id: true, orderno: true },
    }),
    prisma.stockLocation.findMany({
      where: { id: { in: placeIds } },
      select: { storeLocationId: true },
    }),
    prisma.boxNote.findMany({
      where: { kind: "STRAY", productId: { in: productIds }, clearedAt: null },
      select: {
        id: true,
        productId: true,
        boxes: true,
        stockLocationId: true,
        storeLocationId: true,
      },
    }),
  ]);
  const storeIds = [
    ...new Set([...places.map((p) => p.storeLocationId), ...strays.map((s) => s.storeLocationId)]),
  ];
  const tree = await prisma.stockLocation.findMany({
    where: { storeLocationId: { in: storeIds } },
    select: { id: true, parentId: true, name: true },
  });
  const product = new Map(products.map((p) => [p.id, p]));
  const orderno = new Map(orders.map((o) => [o.id, o.orderno]));
  return res.status(200).json({
    run,
    notes,
    rows: rows.map((r) => ({
      ...r,
      orderno: orderno.get(r.salesOrderId) ?? "",
      productName: product.get(r.productId)?.name ?? "",
      productNumber: product.get(r.productId)?.productNumber ?? "",
      boxesPerUnit: Math.max(1, product.get(r.productId)?.boxesPerUnit ?? 1),
      fromPath: r.fromStockLocationId ? placePath(tree, r.fromStockLocationId) : null,
    })),
    strays: strays.map((s) => ({
      noteId: s.id,
      productId: s.productId,
      boxes: s.boxes,
      placePath: placePath(tree, s.stockLocationId),
    })),
    aboard: onTruck.map((a) => ({
      storeLocationId: a.storeLocationId,
      orderno: a.orderno ?? "",
      productName: a.productName,
      quantity: a.quantity,
    })),
  });
}

type PostKind = "PICK" | "LOAD" | "UNLOAD";

function postKind(body: Record<string, unknown>): PostKind {
  if (body.unload === true) return "UNLOAD";
  if (body.load === true) return "LOAD";
  return "PICK";
}

function runPost(
  tx: Prisma.TransactionClient,
  kind: PostKind,
  body: Record<string, unknown>,
  ctx: { deliveryRunId: number; actor: string | null; actionKey: string },
) {
  const { deliveryRunId, actor, actionKey } = ctx;
  switch (kind) {
    case "UNLOAD":
      return unloadRun(tx, {
        deliveryRunId,
        toStockLocationId: Number(body.toStockLocationId),
        actor,
        actionKey,
      });
    case "LOAD":
      return loadRun(tx, deliveryRunId, actor, actionKey);
    case "PICK":
      return pickUnits(tx, {
        deliveryRunId,
        salesOrderId: Number(body.salesOrderId),
        productId: Number(body.productId),
        units: Number(body.units),
        fromStockLocationId: Number(body.fromStockLocationId),
        toStockLocationId: Number(body.toStockLocationId),
        boxes: Array.isArray(body.boxes) ? body.boxes.map(Number) : undefined,
        actor,
        actionKey,
      });
  }
}

export async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  try {
    if (req.method === "GET") {
      const runId = Number(req.query.runId);
      return Number.isInteger(runId) && runId > 0 ? await runPull(res, runId) : await listRuns(res);
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", ["GET", "POST"]);
      return res.status(405).json({ error: "Method not allowed" });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const actionKey = parseActionKey(body.actionKey);
    if (actionKey instanceof ActionKeyError)
      return res.status(400).json({ error: actionKey.message });
    const deliveryRunId = Number(body.deliveryRunId);
    if (!Number.isInteger(deliveryRunId))
      return res.status(400).json({ error: "deliveryRunId is required." });
    const actor = session.user?.email || null;
    const kind = postKind(body);
    const { result, replayed } = await withAction<Record<string, unknown>>(
      actionKey,
      { kind, actor },
      (tx) => runPost(tx, kind, body, { deliveryRunId, actor, actionKey }),
    );
    return res.status(replayed ? 200 : 201).json({ ...result, replayed });
  } catch (error) {
    if (error instanceof PickError || error instanceof BoxError || error instanceof TruckError) {
      return res.status(400).json({ error: error.message });
    }
    if (error instanceof MoveModeError) {
      return res
        .status(400)
        .json({ error: "That unit is at another place that needs a transfer first." });
    }
    logError("Error picking on a handheld", error);
    return res.status(500).json({ error: "Failed to pick" });
  }
}

export default requirePermission("warehouse.operate", handler);
