// /app/src/pages/api/upboard/clock-in.ts
// POST /api/upboard/clock-in
// Body: { staffMemberId, storeLocation }
//
// Clocks a staff member in at a store:
// 1. Creates a StaffShift record
// 2. Adds them to the bottom of the store's up-board rotation
// 3. If they're the only one, they're automatically UP

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { resolveStoreLocationId } from "@/lib/storeLocationResolver";
import { logError } from "@/lib/logger";
import { getErrorMessage } from "@/lib/toastError";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const { staffMemberId, storeLocation } = req.body;
  if (!staffMemberId || !storeLocation) {
    return res.status(400).json({ error: "staffMemberId and storeLocation required" });
  }

  const store = storeLocation as string;

  try {
    const storeLocationId = await resolveStoreLocationId(store);
    // Check if already clocked in (open shift)
    const openShift = await prisma.staffShift.findFirst({
      where: { staffMemberId, clockOut: null },
    });
    if (openShift) {
      return res.status(409).json({
        error: "Already clocked in",
        shift: openShift,
      });
    }

    // Create shift
    const shift = await prisma.staffShift.create({
      data: {
        staffMemberId,
        storeLocation: store,
        storeLocationId: storeLocationId ?? undefined,
      },
    });

    // Find max position on this board
    const maxEntry = await prisma.upBoardEntry.findFirst({
      where: { storeLocation: store },
      orderBy: { position: "desc" },
    });
    const nextPosition = (maxEntry?.position ?? 0) + 1;

    // Check if board is empty (this person will be UP)
    const isFirst = nextPosition === 1;

    // Remove any stale entry for this person at this store
    await prisma.upBoardEntry.deleteMany({
      where: { staffMemberId, storeLocation: store },
    });

    // Add to board
    const entry = await prisma.upBoardEntry.create({
      data: {
        staffMemberId,
        storeLocation: store,
        storeLocationId: storeLocationId ?? undefined,
        position: nextPosition,
        status: isFirst ? "UP" : "AVAILABLE",
      },
    });

    return res.status(201).json({ shift, entry });
  } catch (err: unknown) {
    logError("Clock-in error", err);
    return res.status(500).json({ error: getErrorMessage(err, "Failed to clock in") });
  }
}
