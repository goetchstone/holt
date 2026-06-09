// /app/src/pages/api/dispatch/stops/[id].ts

import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "PUT") {
    res.setHeader("Allow", ["PUT"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const id = Number.parseInt(req.query.id as string);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid stop ID" });

  const { status, notes, estimatedArrival, actualArrival, recipientName } = req.body;

  try {
    const data: any = {
      notes: notes !== undefined ? notes : undefined,
      estimatedArrival: estimatedArrival !== undefined ? new Date(estimatedArrival) : undefined,
      actualArrival: actualArrival !== undefined ? new Date(actualArrival) : undefined,
      recipientName: recipientName !== undefined ? recipientName : undefined,
    };

    if (status !== undefined) {
      data.status = status;
      if (status === "ARRIVED" && !actualArrival) {
        data.actualArrival = new Date();
      }
      if (status === "COMPLETED") {
        data.completedAt = new Date();
      }
    }

    const stop = await prisma.deliveryStop.update({
      where: { id },
      data,
      include: {
        serviceAppointment: {
          include: {
            customer: true,
            address: true,
          },
        },
      },
    });

    return res.status(200).json(stop);
  } catch (error) {
    logError("Error updating stop", error);
    return res.status(500).json({ error: "Failed to update stop" });
  }
}
