// /app/src/pages/api/referral-sources/[id].ts
//
// Rename, reorder, switch off or delete one of the store's referral sources
// (Settings > Referral sources). One customers use is switched off, not deleted
// (lib/customers/referrals.ts).

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import {
  ReferralError,
  deleteReferralSource,
  updateReferralSource,
} from "@/lib/customers/referrals";

export async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  const id = Number.parseInt(req.query.id as string, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid referral source ID" });
  const by = session.user?.email ?? null;
  try {
    if (req.method === "PUT") {
      const source = await prisma.$transaction((tx) =>
        updateReferralSource(tx, id, req.body ?? {}, by),
      );
      return res.status(200).json(source);
    }
    if (req.method === "DELETE") {
      await prisma.$transaction((tx) => deleteReferralSource(tx, id));
      return res.status(200).json({ success: true });
    }
  } catch (err) {
    if (err instanceof ReferralError) return res.status(err.status).json({ error: err.message });
    logError(`${req.method} /api/referral-sources/[id] error`, err);
    return res.status(500).json({ error: "Failed to save the referral source" });
  }
  res.setHeader("Allow", "PUT, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

export default requirePermission("admin.settings", handler);
