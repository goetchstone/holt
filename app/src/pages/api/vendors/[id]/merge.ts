// /app/src/pages/api/vendors/[id]/merge.ts
//
// GAP-22: merge this vendor into another (lib/vendors/mergeVendor.ts).
// GET ?into=<id> is what the merge would move and take, and why it can't
// happen yet; POST { intoId } carries it out. A merge deletes a vendor and
// can't be undone, so both are admin.data, the key the customer merge takes.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { VendorMergeError, mergeVendor, planVendorMerge } from "@/lib/vendors/mergeVendor";

export default requirePermission("admin.data", handler);

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  const fromId = Number(req.query.id);
  if (!Number.isInteger(fromId)) return res.status(400).json({ error: "Invalid vendor id" });

  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const intoId = Number(req.method === "GET" ? req.query.into : req.body?.intoId);
  try {
    if (req.method === "GET") {
      return res.status(200).json(await planVendorMerge(prisma, fromId, intoId));
    }
    const plan = await mergeVendor(prisma, fromId, intoId, session.user?.email ?? null);
    return res.status(200).json(plan);
  } catch (err) {
    if (err instanceof VendorMergeError) {
      return res.status(err.status).json({ error: err.message, problems: err.problems });
    }
    logError(`${req.method} /api/vendors/[id]/merge error`, err, { fromId, intoId });
    return res.status(500).json({ error: "Failed to merge the vendors" });
  }
}
