// /app/src/pages/api/sales/orders/[id]/duplicate.ts
//
// GAP-07: POST copies an order into a new quote at today's prices
// (lib/sales/duplicateOrder.ts) and answers { id, orderno } for the screen to
// open. Writing a quote is sales.write, as create-from-cart is. The copy gives
// no discount, so no manager's approval is ever needed for it.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { getAppSettings } from "@/lib/appSettings";
import { DeliveryFeeError } from "@/lib/delivery/deliveryFee";
import { DuplicateOrderError, duplicateOrder } from "@/lib/sales/duplicateOrder";

export async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const orderId = Number.parseInt(req.query.id as string, 10);
  if (Number.isNaN(orderId)) return res.status(400).json({ error: "Invalid order ID" });
  const email = session.user?.email ?? null;
  try {
    const settings = await getAppSettings();
    const copy = await prisma.$transaction(async (tx) => {
      const staff = email
        ? await tx.staffMember.findFirst({ where: { email }, select: { displayName: true } })
        : null;
      return duplicateOrder(tx, {
        orderId,
        actor: { email, displayName: staff?.displayName ?? null },
        settings,
      });
    });
    return res.status(201).json(copy);
  } catch (err) {
    if (err instanceof DuplicateOrderError || err instanceof DeliveryFeeError) {
      return res.status(err.status).json({ error: err.message });
    }
    logError("POST /api/sales/orders/[id]/duplicate error", err);
    return res.status(500).json({ error: "Failed to copy the order" });
  }
}

export default requirePermission("sales.write", handler);
