// /app/src/pages/api/purchasing/orders/[id]/receive.ts

import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import {
  receivePurchaseOrder,
  ReceiveError,
  type ReceiveItem,
} from "@/lib/purchasing/receivePurchaseOrder";

export async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { id } = req.query;
  if (!id || typeof id !== "string") {
    return res.status(400).json({ error: "Purchase order ID is required." });
  }

  const poId = Number.parseInt(id);
  if (Number.isNaN(poId)) {
    return res.status(400).json({ error: "Invalid purchase order ID." });
  }

  try {
    const { storeLocationId, items } = req.body as {
      storeLocationId: number;
      items: ReceiveItem[];
    };

    if (!storeLocationId) {
      return res.status(400).json({ error: "storeLocationId is required." });
    }

    // ReceivingRecord.receiverUserId is a foreign key to User.id (a CUID). This
    // route used to write the user's EMAIL there ("system" when absent), which
    // can never match a User.id, so every native receipt failed with a foreign
    // key violation. The POS import path resolves the id for the same reason
    // (lib/adapters/ordorite/runners.ts, resolveImportUserId).
    const receiverUserId = session.user?.id;
    if (!receiverUserId) {
      return res.status(401).json({ error: "Sign in again: your session has no user id." });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items array is required." });
    }

    const result = await prisma.$transaction((tx) =>
      receivePurchaseOrder(tx, {
        poId,
        storeLocationId,
        items,
        receiverUserId,
        actor: session.user?.email || null,
      }),
    );
    const { printItems } = result;

    return res.status(200).json({
      message: `${result.receivingRecords.length} item(s) received`,
      receivingRecords: result.receivingRecords,
      newStatus: result.newStatus,
      printItems,
    });
  } catch (error) {
    if (error instanceof ReceiveError) {
      return res.status(error.status).json({ error: error.message });
    }
    logError("Error receiving items", error);
    return res.status(500).json({ error: "Failed to receive items." });
  }
}

export default requirePermission("purchasing.receive", handler);
