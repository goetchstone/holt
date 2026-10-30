// /app/src/pages/api/purchasing/receiving/[id]/unreceive.ts
//
// GAP-02: POST { quantity } -> { remaining, newStatus } -- take a receipt back,
// whole or in part: goods booked in that never came, or came short
// (lib/purchasing/unreceive.ts). The units leave stock from where they landed
// and leave their product's average landed cost; the PO's status is worked out
// again.
//
// "Adjust inventory", the sensitive key for changing on-hand outside a count or
// a sale, which this is. A store gives it to the roles it trusts with that.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { UnreceiveError, unreceive } from "@/lib/purchasing/unreceive";

/** Exported for integration tests. */
export async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }
  const receivingRecordId = Number.parseInt(String(req.query.id), 10);
  if (Number.isNaN(receivingRecordId))
    return res.status(400).json({ error: "Invalid receipt ID." });

  try {
    const result = await prisma.$transaction((tx) =>
      unreceive(tx, {
        receivingRecordId,
        quantity: (req.body ?? {}).quantity,
        actor: session.user?.email ?? null,
      }),
    );
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof UnreceiveError) return res.status(err.status).json({ error: err.message });
    logError("Error correcting a receipt", err);
    return res.status(500).json({ error: "Failed to correct the receipt." });
  }
}

export default requirePermission("inventory.adjust", handler);
