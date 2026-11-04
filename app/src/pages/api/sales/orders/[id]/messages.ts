// /app/src/pages/api/sales/orders/[id]/messages.ts
//
// GAP-13: GET the automatic messages Holt sent this order's customer, or chose
// not to and why (lib/messages/due.ts), newest first, each with where its
// email stands in the queue: waiting, sent or failed.

import type { NextApiRequest, NextApiResponse } from "next";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { orderMessages } from "@/lib/messages/history";

export async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const salesOrderId = Number.parseInt(req.query.id as string, 10);
  if (Number.isNaN(salesOrderId)) return res.status(400).json({ error: "Invalid order ID" });
  try {
    return res.status(200).json(await orderMessages(salesOrderId));
  } catch (err) {
    logError("GET /api/sales/orders/[id]/messages error", err);
    return res.status(500).json({ error: "Failed to load the order's messages" });
  }
}

export default requirePermission("sales.read", handler);
