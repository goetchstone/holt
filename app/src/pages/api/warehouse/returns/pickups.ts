// /app/src/pages/api/warehouse/returns/pickups.ts

import { NextApiRequest, NextApiResponse } from "next";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  try {
    const returns = await prisma.return.findMany({
      where: {
        pickupRequired: true,
        status: { in: ["INITIATED", "PICKUP_SCHEDULED"] },
      },
      include: {
        salesOrder: { select: { orderno: true } },
        customer: { select: { firstName: true, lastName: true, phone: true } },
        pickupAddress: true,
      },
      orderBy: [{ pickupDate: "asc" }, { created: "asc" }],
    });

    const mapped = returns.map((r) => ({
      id: r.id,
      returnNumber: r.returnNumber,
      status: r.status,
      orderno: r.salesOrder.orderno,
      customerName: r.customer
        ? `${r.customer.firstName || ""} ${r.customer.lastName || ""}`.trim()
        : "",
      customerPhone: r.customer?.phone || null,
      productName: r.productName,
      quantity: r.quantity,
      pickupDate: r.pickupDate,
      pickupTimeSlot: r.pickupTimeSlot,
      pickupNotes: r.pickupNotes,
      address: r.pickupAddress
        ? {
            address1: r.pickupAddress.address1,
            address2: r.pickupAddress.address2,
            city: r.pickupAddress.city,
            state: r.pickupAddress.state,
            zip: r.pickupAddress.zip,
          }
        : null,
    }));

    return res.status(200).json({ pickups: mapped });
  } catch (error) {
    logError("Error fetching pickup schedule", error);
    return res.status(500).json({ error: "Failed to fetch pickup schedule" });
  }
}

// Pickup-required returns awaiting collection, with the customer's phone and
// street address — the same return rows returns/index.ts lists, so the same
// capability.
export default requirePermission("sales.return", handler);
