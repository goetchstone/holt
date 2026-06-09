// /app/src/pages/api/upboard/clock-out.ts
// POST /api/upboard/clock-out
// Body: { staffMemberId }
//
// Clocks a staff member out:
// 1. Closes their open StaffShift
// 2. Removes them from the up-board
// 3. Compacts positions so there are no gaps

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { compactAndPromote } from "@/lib/upboard";
import { logError } from "@/lib/logger";
import { getErrorMessage } from "@/lib/toastError";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const { staffMemberId } = req.body;
  if (!staffMemberId) return res.status(400).json({ error: "staffMemberId required" });

  try {
    // Close open shift
    const openShift = await prisma.staffShift.findFirst({
      where: { staffMemberId, clockOut: null },
    });

    if (openShift) {
      await prisma.staffShift.update({
        where: { id: openShift.id },
        data: { clockOut: new Date() },
      });
    }

    // Find and remove their up-board entry
    const entry = await prisma.upBoardEntry.findFirst({
      where: { staffMemberId },
    });

    if (entry) {
      await prisma.upBoardEntry.delete({ where: { id: entry.id } });
      await compactAndPromote(entry.storeLocation);
    }

    return res.json({ success: true });
  } catch (err: unknown) {
    logError("Clock-out error", err);
    return res.status(500).json({ error: getErrorMessage(err, "Failed to clock out") });
  }
}
