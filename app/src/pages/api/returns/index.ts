// /app/src/pages/api/returns/index.ts

import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { generateReturnNumber } from "@/lib/returnService";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method === "GET") {
    return handleGet(req, res);
  } else if (req.method === "POST") {
    const mutationRole = (session as unknown as { role?: string })?.role;
    if (!["MANAGER", "ADMIN", "REGISTER", "WAREHOUSE"].includes(mutationRole ?? "")) {
      return res.status(403).json({ error: "Insufficient role for this action" });
    }

    return handlePost(req, res, session.user?.email || null);
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const page = Number.parseInt(req.query.page as string) || 1;
  const limit = Number.parseInt(req.query.limit as string) || 10;
  const search = (req.query.search as string) || "";
  const status = req.query.status as string | undefined;
  const filter = (req.query.filter as string) || "all";

  const activeStatuses = [
    "INITIATED",
    "PICKUP_SCHEDULED",
    "PICKUP_COMPLETED",
    "RECEIVED",
    "INSPECTED",
  ];
  const completedStatuses = ["RESTOCKED", "WRITTEN_OFF", "CLOSED", "CANCELLED"];

  const where: any = {};

  if (status) {
    where.status = status;
  } else if (filter === "active") {
    where.status = { in: activeStatuses };
  } else if (filter === "completed") {
    where.status = { in: completedStatuses };
  }

  if (search) {
    where.OR = [
      { returnNumber: { contains: search, mode: "insensitive" } },
      { salesOrder: { orderno: { contains: search, mode: "insensitive" } } },
      { customer: { firstName: { contains: search, mode: "insensitive" } } },
      { customer: { lastName: { contains: search, mode: "insensitive" } } },
      { productName: { contains: search, mode: "insensitive" } },
    ];
  }

  try {
    const [returns, total] = await Promise.all([
      prisma.return.findMany({
        where,
        include: {
          salesOrder: { select: { orderno: true } },
          customer: { select: { firstName: true, lastName: true } },
        },
        orderBy: { created: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.return.count({ where }),
    ]);

    const mapped = returns.map((r) => ({
      id: r.id,
      returnNumber: r.returnNumber,
      status: r.status,
      reason: r.reason,
      orderno: r.salesOrder.orderno,
      customerName: r.customer
        ? `${r.customer.firstName || ""} ${r.customer.lastName || ""}`.trim()
        : "",
      productName: r.productName,
      quantity: r.quantity,
      pickupRequired: r.pickupRequired,
      created: r.created,
    }));

    return res.status(200).json({ returns: mapped, total });
  } catch (error) {
    logError("Error fetching returns", error);
    return res.status(500).json({ error: "Failed to fetch returns" });
  }
}

async function handlePost(req: NextApiRequest, res: NextApiResponse, changedBy: string | null) {
  const {
    salesOrderId,
    lineItemId,
    reason,
    reasonNotes,
    pickupRequired,
    pickupAddressId,
    quantity,
  } = req.body;

  if (!salesOrderId || !reason) {
    return res.status(400).json({ error: "salesOrderId and reason are required" });
  }

  try {
    const order = await prisma.salesOrder.findUniqueOrThrow({
      where: { id: Number.parseInt(salesOrderId) },
      include: {
        customer: { select: { id: true } },
        lineItems: {
          where: lineItemId ? { id: Number.parseInt(lineItemId) } : undefined,
          select: {
            id: true,
            productId: true,
            productName: true,
            partNo: true,
            orderedQuantity: true,
          },
        },
      },
    });

    const lineItem = lineItemId
      ? order.lineItems.find((li) => li.id === Number.parseInt(lineItemId))
      : null;

    const returnNumber = await generateReturnNumber();

    const result = await prisma.$transaction(async (tx) => {
      const ret = await tx.return.create({
        data: {
          returnNumber,
          reason,
          reasonNotes: reasonNotes || undefined,
          salesOrderId: order.id,
          lineItemId: lineItem?.id,
          customerId: order.customer?.id,
          productId: lineItem?.productId,
          productName: lineItem?.productName,
          partNo: lineItem?.partNo,
          quantity: quantity ? Number.parseInt(quantity) : 1,
          pickupRequired: pickupRequired || false,
          pickupAddressId: pickupAddressId ? Number.parseInt(pickupAddressId) : undefined,
          createdBy: changedBy,
        },
      });

      await tx.orderChangeLog.create({
        data: {
          salesOrderId: order.id,
          lineItemId: lineItem?.id,
          changeType: "RETURN_INITIATED",
          newValue: returnNumber,
          reason: `${reason}${reasonNotes ? `: ${reasonNotes}` : ""}`,
          changedBy,
        },
      });

      return ret;
    });

    return res.status(201).json(result);
  } catch (error) {
    logError("Error creating return", error);
    return res.status(500).json({ error: "Failed to create return" });
  }
}
