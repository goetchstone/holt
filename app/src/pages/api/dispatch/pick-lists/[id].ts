// /app/src/pages/api/dispatch/pick-lists/[id].ts

import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const id = Number.parseInt(req.query.id as string);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid pick list ID" });

  if (req.method === "GET") {
    return handleGet(id, res);
  } else if (req.method === "PUT") {
    const mutationRole = (session as unknown as { role?: string })?.role;
    if (!["WAREHOUSE", "MANAGER", "ADMIN", "INSTALLER"].includes(mutationRole ?? "")) {
      return res.status(403).json({ error: "Insufficient role for this action" });
    }

    return handlePut(id, req, res, session.user?.email || null);
  }

  res.setHeader("Allow", ["GET", "PUT"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}

async function handleGet(id: number, res: NextApiResponse) {
  try {
    const pickList = await prisma.pickList.findUnique({
      where: { id },
      include: {
        assignedTo: { select: { id: true, displayName: true } },
        items: {
          include: {
            product: {
              select: { id: true, name: true, productNumber: true },
            },
            orderLineItem: {
              select: { id: true, productName: true },
            },
            fromStockLocation: {
              select: { id: true, name: true },
            },
            fromStoreLocation: {
              select: { id: true, name: true },
            },
          },
        },
      },
    });

    if (!pickList) {
      return res.status(404).json({ error: "Pick list not found" });
    }

    return res.status(200).json(pickList);
  } catch (error) {
    logError("Error fetching pick list", error);
    return res.status(500).json({ error: "Failed to fetch pick list" });
  }
}

async function handlePut(
  id: number,
  req: NextApiRequest,
  res: NextApiResponse,
  updatedBy: string | null,
) {
  const { status, assignedToId } = req.body;

  try {
    const data: any = { updatedBy };

    if (status !== undefined) {
      data.status = status;
    }

    if (assignedToId !== undefined) {
      data.assignedToId = assignedToId ? Number.parseInt(assignedToId) : null;
    }

    const pickList = await prisma.pickList.update({
      where: { id },
      data,
      include: {
        assignedTo: { select: { id: true, displayName: true } },
      },
    });

    return res.status(200).json(pickList);
  } catch (error) {
    logError("Error updating pick list", error);
    return res.status(500).json({ error: "Failed to update pick list" });
  }
}
