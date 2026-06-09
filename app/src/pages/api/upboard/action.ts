// /app/src/pages/api/upboard/action.ts
// POST /api/upboard/action
// Body: { staffMemberId, action, customerNote? }
//
// Actions:
//   "take_customer" — person at position 1 (UP) goes to WITH_CUSTOMER,
//                      next AVAILABLE person becomes UP
//   "finish_customer" — person goes from WITH_CUSTOMER back to bottom of rotation
//   "go_on_break"    — person goes ON_BREAK (removed from rotation temporarily)
//   "return_from_break" — person goes back to bottom of rotation as AVAILABLE

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { resolveStoreLocationId } from "@/lib/storeLocationResolver";
import { logError } from "@/lib/logger";
import { getErrorMessage } from "@/lib/toastError";

async function promoteNextUp(storeLocation: string) {
  // Find the first AVAILABLE person
  const next = await prisma.upBoardEntry.findFirst({
    where: { storeLocation, status: "AVAILABLE" },
    orderBy: { position: "asc" },
  });
  if (next) {
    await prisma.upBoardEntry.update({
      where: { id: next.id },
      data: { status: "UP", statusSince: new Date() },
    });
  }
}

async function getMaxPosition(storeLocation: string): Promise<number> {
  const max = await prisma.upBoardEntry.findFirst({
    where: { storeLocation },
    orderBy: { position: "desc" },
  });
  return max?.position ?? 0;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const { staffMemberId, action, customerNote } = req.body;
  if (!staffMemberId || !action) {
    return res.status(400).json({ error: "staffMemberId and action required" });
  }

  try {
    // Find this person's board entry
    const entry = await prisma.upBoardEntry.findFirst({
      where: { staffMemberId },
    });
    if (!entry) {
      return res.status(404).json({ error: "Not on any up-board. Clock in first." });
    }

    const store = entry.storeLocation;
    let interactionId: number | null = null;

    switch (action) {
      case "take_customer": {
        if (entry.status !== "UP") {
          return res.status(400).json({ error: "Not currently UP" });
        }
        await prisma.upBoardEntry.update({
          where: { id: entry.id },
          data: {
            status: "WITH_CUSTOMER",
            statusSince: new Date(),
            customerNote: customerNote || null,
          },
        });
        await promoteNextUp(store);

        // Create a CustomerInteraction for this walk-in
        const resolvedStoreLocationId =
          entry.storeLocationId ?? (await resolveStoreLocationId(store)) ?? undefined;
        const interaction = await prisma.customerInteraction.create({
          data: {
            staffMemberId,
            storeLocation: store,
            storeLocationId: resolvedStoreLocationId,
            source: "WALK_IN",
            isActive: true,
            createdBy: session.user?.email || null,
          },
        });
        interactionId = interaction.id;
        break;
      }

      case "finish_customer": {
        if (entry.status !== "WITH_CUSTOMER") {
          return res.status(400).json({ error: "Not WITH_CUSTOMER" });
        }
        const maxPos = await getMaxPosition(store);
        // Check if there are any AVAILABLE or UP people
        const hasOthersAvailable = await prisma.upBoardEntry.findFirst({
          where: {
            storeLocation: store,
            status: { in: ["UP", "AVAILABLE"] },
            id: { not: entry.id },
          },
        });

        await prisma.upBoardEntry.update({
          where: { id: entry.id },
          data: {
            position: maxPos + 1,
            status: hasOthersAvailable ? "AVAILABLE" : "UP",
            statusSince: new Date(),
            customerNote: null,
          },
        });

        // Close the staff member's active interaction
        const activeInteraction = await prisma.customerInteraction.findFirst({
          where: { staffMemberId, isActive: true },
          orderBy: { startedAt: "desc" },
        });
        if (activeInteraction) {
          await prisma.customerInteraction.update({
            where: { id: activeInteraction.id },
            data: {
              isActive: false,
              endedAt: new Date(),
              outcome: activeInteraction.outcome || "BROWSING",
              updatedBy: session.user?.email || null,
            },
          });
        }
        break;
      }

      case "go_on_break": {
        await prisma.upBoardEntry.update({
          where: { id: entry.id },
          data: {
            status: "ON_BREAK",
            statusSince: new Date(),
          },
        });
        // If they were UP, promote next
        if (entry.status === "UP") {
          await promoteNextUp(store);
        }
        break;
      }

      case "return_from_break": {
        if (entry.status !== "ON_BREAK") {
          return res.status(400).json({ error: "Not ON_BREAK" });
        }
        const maxPos2 = await getMaxPosition(store);
        const hasUp = await prisma.upBoardEntry.findFirst({
          where: { storeLocation: store, status: "UP" },
        });
        await prisma.upBoardEntry.update({
          where: { id: entry.id },
          data: {
            position: maxPos2 + 1,
            status: hasUp ? "AVAILABLE" : "UP",
            statusSince: new Date(),
          },
        });
        break;
      }

      default:
        return res.status(400).json({
          error: `Unknown action: ${action}. Use: take_customer, finish_customer, go_on_break, return_from_break`,
        });
    }

    // Return updated board
    const board = await prisma.upBoardEntry.findMany({
      where: { storeLocation: store },
      include: {
        staffMember: { select: { id: true, displayName: true, role: true } },
      },
      orderBy: { position: "asc" },
    });

    return res.json({ board, interactionId });
  } catch (err: unknown) {
    logError("Up-board action error", err);
    return res.status(500).json({ error: getErrorMessage(err, "Up-board action failed") });
  }
}
