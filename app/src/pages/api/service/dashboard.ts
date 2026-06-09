// /app/src/pages/api/service/dashboard.ts

import { prisma } from "@/lib/prisma";
import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  try {
    const staff = await prisma.staffMember.findFirst({
      where: { email: session.user?.email },
      select: { id: true },
    });

    const now = new Date();

    const [openCases, inProgressCases, waitingCases, myAssignedCases, overdueTasks, recentCases] =
      await Promise.all([
        prisma.serviceCase.count({
          where: { status: { isClosed: false } },
        }),
        prisma.serviceCase.count({
          where: {
            status: { isClosed: false, name: { contains: "Progress", mode: "insensitive" } },
          },
        }),
        prisma.serviceCase.count({
          where: {
            status: { isClosed: false, name: { contains: "Waiting", mode: "insensitive" } },
          },
        }),
        staff
          ? prisma.serviceCase.count({
              where: { assignedToId: staff.id, status: { isClosed: false } },
            })
          : Promise.resolve(0),
        prisma.serviceTask.count({
          where: {
            dueDate: { lt: now },
            status: { notIn: ["COMPLETED", "CANCELLED"] },
          },
        }),
        prisma.serviceCase.findMany({
          take: 5,
          orderBy: { created: "desc" },
          include: {
            type: { select: { name: true } },
            status: { select: { name: true, color: true } },
            priority: { select: { name: true, color: true } },
            customer: { select: { firstName: true, lastName: true } },
            assignedTo: { select: { displayName: true } },
          },
        }),
      ]);

    return res.status(200).json({
      openCases,
      inProgressCases,
      waitingCases,
      myAssignedCases,
      overdueTasks,
      recentCases,
    });
  } catch (err) {
    logError("GET /service/dashboard error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
