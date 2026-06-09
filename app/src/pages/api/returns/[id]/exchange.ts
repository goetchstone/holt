// /app/src/pages/api/returns/[id]/exchange.ts

import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  // Processing an exchange touches inventory + balances. Register desk,
  // warehouse returns, manager, and admin only.
  const role = (session as unknown as { role?: string })?.role;
  if (!["SUPER_ADMIN", "MANAGER", "ADMIN", "REGISTER", "WAREHOUSE"].includes(role ?? "")) {
    return res.status(403).json({ error: "Insufficient role to process exchange" });
  }

  const returnId = Number.parseInt(req.query.id as string);
  if (Number.isNaN(returnId)) return res.status(400).json({ error: "Invalid return ID" });

  const changedBy = session.user?.email || null;

  try {
    const ret = await prisma.return.findUniqueOrThrow({
      where: { id: returnId },
      include: {
        salesOrder: { select: { customerId: true, storeLocation: true, salesperson: true } },
      },
    });

    if (ret.exchangeOrderId) {
      return res.status(400).json({ error: "Exchange order already exists for this return" });
    }

    // Generate a new order number for the exchange
    const now = new Date();
    const yy = now.getFullYear().toString().slice(-2);
    const mm = (now.getMonth() + 1).toString().padStart(2, "0");
    const dd = now.getDate().toString().padStart(2, "0");
    const prefix = `EX-${yy}${mm}${dd}-`;

    const lastOrder = await prisma.salesOrder.findFirst({
      where: { orderno: { startsWith: prefix } },
      orderBy: { orderno: "desc" },
      select: { orderno: true },
    });

    let seq = 1;
    if (lastOrder) {
      const lastSeq = Number.parseInt(lastOrder.orderno.replace(prefix, ""), 10);
      if (!Number.isNaN(lastSeq)) seq = lastSeq + 1;
    }
    const orderno = `${prefix}${seq.toString().padStart(3, "0")}`;

    const result = await prisma.$transaction(async (tx) => {
      // Create the exchange order as a QUOTE
      const exchangeOrder = await tx.salesOrder.create({
        data: {
          orderno,
          orderDate: now,
          status: "QUOTE",
          customerId: ret.salesOrder.customerId,
          storeLocation: ret.salesOrder.storeLocation,
          salesperson: ret.salesOrder.salesperson,
          orderNotes: `Exchange for return ${ret.returnNumber}`,
          createdBy: changedBy,
        },
      });

      // Link to the return
      await tx.return.update({
        where: { id: returnId },
        data: { exchangeOrderId: exchangeOrder.id, updatedBy: changedBy },
      });

      // Audit log
      await tx.orderChangeLog.create({
        data: {
          salesOrderId: ret.salesOrderId,
          changeType: "RETURN_EXCHANGE_CREATED",
          newValue: orderno,
          changedBy,
        },
      });

      return exchangeOrder;
    });

    return res.status(201).json({ exchangeOrder: result });
  } catch (error) {
    logError("Error creating exchange order", error);
    return res.status(500).json({ error: "Failed to create exchange order" });
  }
}
