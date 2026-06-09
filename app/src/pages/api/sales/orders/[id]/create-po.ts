// /app/src/pages/api/sales/orders/[id]/create-po.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { onPaymentReceived } from "@/lib/paymentService";
import {
  unauthorized,
  badRequest,
  notFound,
  methodNotAllowed,
  handleError,
} from "@/lib/apiResponse";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return unauthorized(res);

  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const orderId = Number.parseInt(req.query.id as string);
  if (Number.isNaN(orderId)) return badRequest(res, "Invalid order ID");

  try {
    const order = await prisma.salesOrder.findUnique({
      where: { id: orderId },
      select: { id: true, status: true, purchaseOrders: { select: { id: true } } },
    });

    if (!order) return notFound(res, "Sales order");

    if (order.purchaseOrders.length > 0) {
      return badRequest(res, "Purchase orders already exist for this sales order");
    }

    await onPaymentReceived(orderId);

    const createdPOs = await prisma.purchaseOrder.findMany({
      where: { salesOrderId: orderId },
      select: { id: true },
    });

    return res.status(201).json({
      purchaseOrderIds: createdPOs.map((po) => po.id),
    });
  } catch (err) {
    return handleError(res, err, "POST /sales/orders/[id]/create-po");
  }
}
