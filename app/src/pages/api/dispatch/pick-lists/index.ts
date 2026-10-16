// /app/src/pages/api/dispatch/pick-lists/index.ts

import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { generatePickList, pickListForClient } from "@/lib/deliveryService";
import { logError } from "@/lib/logger";

export async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method === "GET") {
    return handleGet(req, res);
  } else if (req.method === "POST") {
    return handlePost(req, res, session.user?.email || "");
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const where: any = {};

  if (req.query.status) {
    where.status = req.query.status;
  }

  if (req.query.deliveryRunId) {
    where.deliveryRunId = Number.parseInt(req.query.deliveryRunId as string);
  }

  if (req.query.salesOrderId) {
    where.salesOrderId = Number.parseInt(req.query.salesOrderId as string);
  }

  try {
    const pickLists = await prisma.pickList.findMany({
      where,
      include: {
        assignedTo: { select: { id: true, displayName: true } },
        _count: { select: { items: true } },
      },
      orderBy: { created: "desc" },
    });

    return res.status(200).json({ pickLists });
  } catch (error) {
    logError("Error fetching pick lists", error);
    return res.status(500).json({ error: "Failed to fetch pick lists" });
  }
}

async function handlePost(req: NextApiRequest, res: NextApiResponse, createdBy: string) {
  const { deliveryRunId, salesOrderId } = req.body;

  if (!deliveryRunId && !salesOrderId) {
    return res.status(400).json({ error: "deliveryRunId or salesOrderId is required" });
  }

  try {
    // One builder for both: the pull list (lib/fulfilment/pullList.ts).
    if (deliveryRunId) {
      const pickList = await generatePickList(
        { deliveryRunId: Number.parseInt(deliveryRunId) },
        createdBy,
      );
      return res.status(201).json(pickListForClient(pickList));
    }

    const orderId = Number.parseInt(salesOrderId);
    const order = await prisma.salesOrder.findUnique({
      where: { id: orderId },
      select: { id: true },
    });
    if (!order) {
      return res.status(404).json({ error: "Sales order not found" });
    }
    const pickList = await generatePickList({ salesOrderId: orderId }, createdBy);
    return res.status(201).json(pickListForClient(pickList));
  } catch (error) {
    logError("Error creating pick list", error);
    return res.status(500).json({ error: "Failed to create pick list" });
  }
}

export default requirePermission("warehouse.operate", handler);
