// /app/src/pages/api/customers/[id]/credit/adjust.ts

import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { adjustCredit } from "@/lib/customerCredit";

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const customerId = Number.parseInt(req.query.id as string);
  if (Number.isNaN(customerId)) return res.status(400).json({ error: "Invalid customer ID" });

  try {
    const { amount, reason } = req.body;

    if (amount === undefined || amount === 0) {
      return res.status(400).json({ error: "amount is required and must be non-zero" });
    }

    const txn = await adjustCredit(customerId, Number.parseFloat(amount), {
      reason: reason || undefined,
      createdBy: session.user?.email || undefined,
    });

    return res.status(201).json({
      transaction: {
        ...txn,
        amount: Number(txn.amount),
        balanceBefore: Number(txn.balanceBefore),
        balanceAfter: Number(txn.balanceAfter),
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Internal server error";
    return res.status(400).json({ error: msg });
  }
}

export default requirePermission("customer.credit.adjust", handler);
