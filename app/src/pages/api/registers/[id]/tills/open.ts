// /app/src/pages/api/registers/[id]/tills/open.ts

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import type { PrismaClient } from "@prisma/client";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

interface CountEntry {
  denomination: string;
  quantity: number;
  amount: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Pure(ish) handler body, exported for unit/integration testing (mirrors
 * pages/api/tills/[id]/close.ts and reconcile.ts). Auth happens in the
 * default export below; this function trusts its caller for that.
 */
export async function handleOpenTill(
  req: NextApiRequest,
  res: NextApiResponse,
  session: Session,
  client: PrismaClient,
): Promise<void> {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    res.status(405).end(`Method ${req.method} Not Allowed`);
    return;
  }

  const registerId = Number.parseInt(req.query.id as string);
  if (Number.isNaN(registerId)) {
    res.status(400).json({ error: "Invalid register ID" });
    return;
  }

  try {
    const register = await client.register.findUnique({ where: { id: registerId } });
    if (!register) {
      res.status(404).json({ error: "Register not found" });
      return;
    }
    if (!register.isActive) {
      res.status(400).json({ error: "Register is inactive" });
      return;
    }

    // Till variance discipline (Phase 0.6, docs/domains/pos.md): a prior
    // till on this register closed with a variance escalation (|variance| >
    // $100, see lib/tillVariance.ts). New opens are refused until a
    // MANAGER/ADMIN clears the block via POST /api/registers/[id]/unblock.
    if (register.blockedAt) {
      res.status(409).json({
        error:
          "Register is blocked pending review of a till variance escalation. " +
          "A manager must clear the block (POST /api/registers/[id]/unblock) before a new till can be opened here.",
        blockedAt: register.blockedAt,
        blockReason: register.blockReason,
      });
      return;
    }

    const openTill = await client.till.findFirst({
      where: { registerId, status: "OPEN" },
    });
    if (openTill) {
      res.status(409).json({ error: "A till is already open on this register" });
      return;
    }

    const staff = await client.staffMember.findFirst({
      where: { email: session.user?.email },
    });
    if (!staff) {
      res.status(403).json({ error: "Staff member not found" });
      return;
    }

    const { openingCash = 0, counts } = req.body as {
      openingCash?: number | string;
      counts?: CountEntry[];
    };

    // If the register staff counted denominations on open, the total trumps
    // the raw openingCash field (keeps the two in sync).
    const countsArray = Array.isArray(counts) ? counts : [];
    const countedTotal = countsArray.reduce(
      (sum, c) => sum + (Number.isFinite(c.amount) ? c.amount : 0),
      0,
    );
    const cashAmount =
      countsArray.length > 0
        ? round2(countedTotal)
        : round2(Number.parseFloat(String(openingCash)) || 0);

    const till = await client.$transaction(async (tx) => {
      const created = await tx.till.create({
        data: {
          registerId,
          status: "OPEN",
          openedById: staff.id,
          openingCash: cashAmount,
          createdBy: session.user?.email || null,
        },
        include: {
          register: {
            include: { storeLocation: { select: { name: true } } },
          },
          openedBy: { select: { displayName: true } },
        },
      });

      if (countsArray.length > 0) {
        await tx.tillCount.createMany({
          data: countsArray.map((c) => ({
            tillId: created.id,
            denomination: c.denomination,
            quantity: c.quantity,
            amount: round2(c.amount),
            isOpening: true,
          })),
        });
      }

      return created;
    });

    res.status(201).json({
      ...till,
      openingCash: Number(till.openingCash),
    });
  } catch (err) {
    logError("POST /registers/[registerId]/tills/open error", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  await handleOpenTill(req, res, session, prisma);
}

export default requireAuthWithRole(["REGISTER", "MANAGER", "ADMIN"], handler);
