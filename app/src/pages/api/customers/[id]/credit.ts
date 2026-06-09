// /app/src/pages/api/customers/[id]/credit.ts

import { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { getBalance } from "@/lib/customerCredit";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const customerId = Number.parseInt(req.query.id as string);
  if (Number.isNaN(customerId)) return res.status(400).json({ error: "Invalid customer ID" });

  try {
    const balance = await getBalance(customerId);

    const transactions = await prisma.customerCreditTransaction.findMany({
      where: { customerId },
      orderBy: { created: "desc" },
      take: 50,
      select: {
        id: true,
        type: true,
        amount: true,
        balanceBefore: true,
        balanceAfter: true,
        reference: true,
        notes: true,
        created: true,
        createdBy: true,
        salesOrder: { select: { orderno: true } },
      },
    });

    return res.status(200).json({
      balance,
      transactions: transactions.map((t) => ({
        ...t,
        amount: Number(t.amount),
        balanceBefore: Number(t.balanceBefore),
        balanceAfter: Number(t.balanceAfter),
        orderNo: t.salesOrder?.orderno || null,
      })),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Internal server error";
    return res.status(500).json({ error: msg });
  }
}

export default requireAuthWithRole(
  ["DESIGNER", "MANAGER", "ADMIN", "WAREHOUSE", "MARKETING", "REGISTER", "INSTALLER"],
  handler,
);
