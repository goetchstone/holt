// /app/src/pages/api/dispatch/pick-lists/index.ts

import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { generatePickList } from "@/lib/deliveryService";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method === "GET") {
    return handleGet(req, res);
  } else if (req.method === "POST") {
    const mutationRole = (session as unknown as { role?: string })?.role;
    if (!["WAREHOUSE", "MANAGER", "ADMIN", "INSTALLER"].includes(mutationRole ?? "")) {
      return res.status(403).json({ error: "Insufficient role for this action" });
    }

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
    if (deliveryRunId) {
      const pickList = await generatePickList(Number.parseInt(deliveryRunId), createdBy);
      return res.status(201).json(pickList);
    }

    // Per-order pick list
    const order = await prisma.salesOrder.findUnique({
      where: { id: Number.parseInt(salesOrderId) },
      include: {
        lineItems: {
          where: { productId: { not: null } },
          include: { product: true },
        },
      },
    });

    if (!order) {
      return res.status(404).json({ error: "Sales order not found" });
    }

    const { generatePickListNumber } = await import("@/lib/deliveryService");
    const pickListNumber = await generatePickListNumber();

    const pickList = await prisma.pickList.create({
      data: {
        pickListNumber,
        salesOrderId: order.id,
        status: "CREATED",
        createdBy,
      },
    });

    for (const li of order.lineItems) {
      if (!li.productId) continue;

      const position = await prisma.inventoryPosition.findFirst({
        where: {
          productId: li.productId,
          quantity: { gt: 0 },
        },
        orderBy: { quantity: "desc" },
      });

      await prisma.pickListItem.create({
        data: {
          pickListId: pickList.id,
          orderLineItemId: li.id,
          productId: li.productId,
          quantity: Number(li.orderedQuantity) || 1,
          fromStockLocationId: position?.stockLocationId ?? null,
          fromStoreLocationId: position?.storeLocationId ?? null,
        },
      });
    }

    const result = await prisma.pickList.findUnique({
      where: { id: pickList.id },
      include: {
        items: {
          include: {
            product: true,
            orderLineItem: true,
            fromStockLocation: true,
            fromStoreLocation: true,
          },
        },
      },
    });

    return res.status(201).json(result);
  } catch (error) {
    logError("Error creating pick list", error);
    return res.status(500).json({ error: "Failed to create pick list" });
  }
}
