// /app/src/pages/api/inventory/counts/[id].ts
//
// Post a submitted count (the books change to match it) or cancel it
// (lib/inventory/count.ts). Posting changes stock: Adjust inventory.
//
// POST { action: "post" | "cancel" }

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { cancelCount, CountError, postCount } from "@/lib/inventory/count";
import { logError } from "@/lib/logger";

export async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }
  const id = Number(req.query.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid count ID" });
  const action = req.body?.action;
  const actor = session.user?.email || null;
  try {
    if (action === "post") {
      const diffs = await prisma.$transaction((tx) => postCount(tx, id, { actor }));
      return res
        .status(200)
        .json({ posted: true, changed: diffs.filter((d) => d.difference !== 0).length });
    }
    if (action === "cancel") {
      await prisma.$transaction((tx) => cancelCount(tx, id, actor));
      return res.status(200).json({ cancelled: true });
    }
    return res.status(400).json({ error: 'action must be "post" or "cancel".' });
  } catch (error) {
    if (error instanceof CountError) return res.status(400).json({ error: error.message });
    logError("Error posting a count", error);
    return res.status(500).json({ error: "Failed to update the count" });
  }
}

export default requirePermission("inventory.adjust", handler);
