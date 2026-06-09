// /app/src/pages/api/warehouse/returns/pickups.ts

import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

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
