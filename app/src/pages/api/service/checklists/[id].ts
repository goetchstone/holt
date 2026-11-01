// /app/src/pages/api/service/checklists/[id].ts
//
// Rename, reorder, switch off, re-step or delete one of the store's service
// checklists (Settings > Service). Cases already given it keep their tasks
// (lib/service/checklists.ts).

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { ChecklistError, deleteChecklist, updateChecklist } from "@/lib/service/checklists";

export async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  const id = Number.parseInt(req.query.id as string, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid checklist ID" });
  const by = session.user?.email ?? null;
  try {
    if (req.method === "PUT") {
      const checklist = await prisma.$transaction((tx) =>
        updateChecklist(tx, id, req.body ?? {}, by),
      );
      return res.status(200).json({ id: checklist.id, name: checklist.name });
    }
    if (req.method === "DELETE") {
      await prisma.$transaction((tx) => deleteChecklist(tx, id));
      return res.status(200).json({ success: true });
    }
  } catch (err) {
    if (err instanceof ChecklistError) return res.status(err.status).json({ error: err.message });
    logError(`${req.method} /api/service/checklists/[id] error`, err);
    return res.status(500).json({ error: "Failed to save the checklist" });
  }
  res.setHeader("Allow", "PUT, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

export default requirePermission("admin.config", handler);
