// /app/src/pages/api/dispatch/unassigned.ts

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
    const appointments = await prisma.serviceAppointment.findMany({
      where: {
        type: "DELIVERY",
        deliveryStop: null,
        status: { in: ["PENDING", "SCHEDULED", "CONFIRMED"] },
      },
      include: {
        customer: { select: { id: true, firstName: true, lastName: true, phone: true } },
        address: { select: { address1: true, city: true, state: true, zip: true } },
        salesOrder: {
          select: {
            id: true,
            orderno: true,
            lineItems: { select: { id: true, productName: true, orderedQuantity: true } },
          },
        },
        deliveryZone: { select: { id: true, name: true } },
      },
      orderBy: { created: "asc" },
    });

    const zoneMap = new Map<string, typeof appointments>();
    const unzoned: typeof appointments = [];

    for (const appt of appointments) {
      if (appt.deliveryZone) {
        const zoneName = appt.deliveryZone.name;
        if (!zoneMap.has(zoneName)) {
          zoneMap.set(zoneName, []);
        }
        zoneMap.get(zoneName)!.push(appt);
      } else {
        unzoned.push(appt);
      }
    }

    const zones = Array.from(zoneMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([zoneName, deliveries]) => ({ zoneName, deliveries }));

    return res.status(200).json({ zones, unzoned });
  } catch (error) {
    logError("Error fetching unassigned deliveries", error);
    return res.status(500).json({ error: "Failed to fetch unassigned deliveries" });
  }
}
