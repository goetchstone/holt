// /app/src/pages/api/returns/[id].ts

import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { toQty } from "@/lib/inventory/quantity";
import { logError } from "@/lib/logger";
import { loadReturnDetail } from "@/lib/returns/returnDetail";

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  const id = Number.parseInt(req.query.id as string);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid return ID" });

  if (req.method === "GET") {
    return handleGet(id, res);
  } else if (req.method === "PUT") {
    return handlePut(id, req, res, session.user?.email || null);
  }

  res.setHeader("Allow", ["GET", "PUT"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}

async function handleGet(id: number, res: NextApiResponse) {
  try {
    // The shared contract (lib/returns/returnDetailContract.ts): what the
    // return detail screen reads, sent exactly as it reads it.
    const detail = await loadReturnDetail(prisma, id);
    if (!detail) return res.status(404).json({ error: "Return not found" });
    return res.status(200).json(detail);
  } catch (error) {
    logError("Error fetching return", error);
    return res.status(500).json({ error: "Failed to fetch return" });
  }
}

async function handlePut(
  id: number,
  req: NextApiRequest,
  res: NextApiResponse,
  changedBy: string | null,
) {
  const { pickupAddressId, pickupDate, pickupTimeSlot, pickupNotes, reasonNotes } = req.body;

  try {
    const ret = await prisma.return.update({
      where: { id },
      data: {
        pickupAddressId:
          pickupAddressId !== undefined ? Number.parseInt(pickupAddressId) : undefined,
        pickupDate: pickupDate ? new Date(pickupDate) : undefined,
        pickupTimeSlot: pickupTimeSlot !== undefined ? pickupTimeSlot : undefined,
        pickupNotes: pickupNotes !== undefined ? pickupNotes : undefined,
        reasonNotes: reasonNotes !== undefined ? reasonNotes : undefined,
        updatedBy: changedBy,
      },
    });

    return res.status(200).json({ ...ret, quantity: toQty(ret.quantity) });
  } catch (error) {
    logError("Error updating return", error);
    return res.status(500).json({ error: "Failed to update return" });
  }
}

export default requirePermission("sales.return", handler);
