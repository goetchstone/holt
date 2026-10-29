// /app/src/pages/api/tenders/[id].ts
//
// Edit or delete one of the store's own payment types (Settings -> Payment
// Types). lib/payments/tenders.ts keeps its GL mapping in step and refuses to
// rename, re-kind or delete one that payments were taken with.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { deleteTender, TenderError, updateTender } from "@/lib/payments/tenders";

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  const id = Number.parseInt(req.query.id as string, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid payment type ID" });
  const by = session.user?.email ?? null;

  try {
    if (req.method === "PUT") {
      const tender = await prisma.$transaction((tx) => updateTender(tx, id, req.body ?? {}, by));
      return res.status(200).json(tender);
    }
    if (req.method === "DELETE") {
      await prisma.$transaction((tx) => deleteTender(tx, id));
      return res.status(200).json({ success: true });
    }
  } catch (err) {
    if (err instanceof TenderError) return res.status(err.status).json({ error: err.message });
    logError(`${req.method} /api/tenders/[id] error`, err);
    return res.status(500).json({ error: "Failed to save the payment type" });
  }

  res.setHeader("Allow", "PUT, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

export default requirePermission("admin.settings", handler);
