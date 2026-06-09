// /app/src/pages/api/returns/[id]/refund.ts

import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { processRefund } from "@/lib/paymentService";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  // Issuing a refund moves money. Register (till), Warehouse (returns desk),
  // Manager, and Admin only.
  const role = (session as unknown as { role?: string })?.role;
  if (!["SUPER_ADMIN", "MANAGER", "ADMIN", "REGISTER", "WAREHOUSE"].includes(role ?? "")) {
    return res.status(403).json({ error: "Insufficient role to issue refund" });
  }

  const returnId = Number.parseInt(req.query.id as string);
  if (Number.isNaN(returnId)) return res.status(400).json({ error: "Invalid return ID" });

  const { paymentId, amount, method, reason, registerId, tillId, staffMemberId } = req.body;

  if (!paymentId || !amount) {
    return res.status(400).json({ error: "paymentId and amount are required" });
  }

  const changedBy = session.user?.email || null;

  try {
    const ret = await prisma.return.findUniqueOrThrow({
      where: { id: returnId },
      select: { salesOrderId: true, lineItemId: true, customerId: true },
    });

    const refund = await processRefund(Number.parseInt(paymentId), {
      amount: Number.parseFloat(amount),
      method: method || undefined,
      reason: reason || `Return refund`,
      registerId: registerId ? Number.parseInt(registerId) : undefined,
      tillId: tillId ? Number.parseInt(tillId) : undefined,
      staffMemberId: staffMemberId ? Number.parseInt(staffMemberId) : undefined,
      customerId: ret.customerId || undefined,
      createdBy: changedBy || undefined,
    });

    // Link refund to return
    await prisma.return.update({
      where: { id: returnId },
      data: {
        refundPaymentId: refund.id,
        refundAmount: Number.parseFloat(amount),
        updatedBy: changedBy,
      },
    });

    // Audit log
    await prisma.orderChangeLog.create({
      data: {
        salesOrderId: ret.salesOrderId,
        lineItemId: ret.lineItemId,
        changeType: "RETURN_REFUND_ISSUED",
        newValue: `$${Number.parseFloat(amount).toFixed(2)}`,
        changedBy,
      },
    });

    return res.status(201).json({
      refund: { ...refund, paymentAmount: Number(refund.paymentAmount) },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to process refund";
    logError("Error processing return refund", error);
    return res.status(500).json({ error: message });
  }
}
