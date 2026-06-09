// /app/src/pages/api/sales/orders/[id]/refunds.ts

import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { processRefund, calculateOrderBalance } from "@/lib/paymentService";
import { unauthorized, badRequest, methodNotAllowed, handleError } from "@/lib/apiResponse";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return unauthorized(res);

  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const orderId = Number.parseInt(req.query.id as string);
  if (Number.isNaN(orderId)) return badRequest(res, "Invalid order ID");

  try {
    const { paymentId, amount, method, reason, registerId, tillId, staffMemberId, customerId } =
      req.body;

    if (!paymentId || !amount) return badRequest(res, "paymentId and amount are required");

    const refund = await processRefund(Number.parseInt(paymentId), {
      amount: Number.parseFloat(amount),
      method: method || undefined,
      reason: reason || undefined,
      registerId: registerId ? Number.parseInt(registerId) : undefined,
      tillId: tillId ? Number.parseInt(tillId) : undefined,
      staffMemberId: staffMemberId ? Number.parseInt(staffMemberId) : undefined,
      customerId: customerId ? Number.parseInt(customerId) : undefined,
      createdBy: session.user?.email || undefined,
    });

    const balance = await calculateOrderBalance(orderId);

    return res.status(201).json({
      refund: {
        ...refund,
        paymentAmount: Number(refund.paymentAmount),
      },
      balance,
    });
  } catch (err) {
    return handleError(res, err, "POST /sales/orders/[id]/refunds");
  }
}
