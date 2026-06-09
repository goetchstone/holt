// /app/src/pages/api/warehouse/returns/queue.ts

import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import type { ReturnStatus } from "@prisma/client";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const tab = (req.query.tab as string) || "all";

  let statusFilter: ReturnStatus[] = [];
  switch (tab) {
    case "pickup":
      statusFilter = ["INITIATED", "PICKUP_SCHEDULED"];
      break;
    case "inspection":
      statusFilter = ["RECEIVED", "PICKUP_COMPLETED"];
      break;
    case "decision":
      statusFilter = ["INSPECTED"];
      break;
    default:
      statusFilter = ["INITIATED", "PICKUP_SCHEDULED", "PICKUP_COMPLETED", "RECEIVED", "INSPECTED"];
  }

  try {
    const returns = await prisma.return.findMany({
      where: {
        status: { in: statusFilter },
        ...(tab === "pickup" ? { pickupRequired: true } : {}),
      },
      include: {
        salesOrder: { select: { orderno: true } },
        customer: { select: { firstName: true, lastName: true } },
        receivedLocation: { select: { name: true } },
      },
      orderBy: { created: "asc" },
    });

    const mapped = returns.map((r) => ({
      id: r.id,
      returnNumber: r.returnNumber,
      status: r.status,
      reason: r.reason,
      orderno: r.salesOrder.orderno,
      customerName: r.customer
        ? `${r.customer.firstName || ""} ${r.customer.lastName || ""}`.trim()
        : "",
      productName: r.productName,
      quantity: r.quantity,
      pickupRequired: r.pickupRequired,
      pickupDate: r.pickupDate,
      inspectionCondition: r.inspectionCondition,
      inspectionNotes: r.inspectionNotes,
      receivedLocationName: r.receivedLocation?.name || null,
      created: r.created,
    }));

    return res.status(200).json({ returns: mapped });
  } catch (error) {
    logError("Error fetching return queue", error);
    return res.status(500).json({ error: "Failed to fetch return queue" });
  }
}
