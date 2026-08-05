// /app/src/pages/api/portal/generate-link.ts

import { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { generatePortalToken } from "@/lib/portalToken";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const { orderId } = req.body;
  if (!orderId || typeof orderId !== "number") {
    return res.status(400).json({ error: "orderId is required and must be a number" });
  }

  try {
    const order = await prisma.salesOrder.findUnique({
      where: { id: orderId },
      select: { id: true, customerId: true, orderno: true },
    });

    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    if (!order.customerId) {
      return res.status(400).json({ error: "Order has no associated customer" });
    }

    const token = generatePortalToken(order.id, order.customerId);
    const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
    const url = `${baseUrl}/portal/order?token=${token}`;

    return res.status(200).json({ url, orderno: order.orderno });
  } catch (error) {
    logError("Portal link generation error", error);
    return res.status(500).json({ error: "Failed to generate portal link" });
  }
}

export default requireAuthWithRole(["DESIGNER", "REGISTER", "MANAGER", "ADMIN"], handler);
