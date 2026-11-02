// /app/src/pages/api/service/cases/[id]/checklist.ts
//
// GAP-11: give a service case one of the store's checklists. Each step becomes
// one of the case's tasks, due its number of days after today on the store's
// calendar (lib/service/checklists.ts). Work service, like the case's notes
// and tasks routes.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { getAppSettings } from "@/lib/appSettings";
import { businessDayKey } from "@/lib/reports/businessDay";
import { ChecklistError, applyChecklist } from "@/lib/service/checklists";

export async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const caseId = Number.parseInt(req.query.id as string, 10);
  if (Number.isNaN(caseId)) return res.status(400).json({ error: "Invalid case ID" });
  const checklistId = (req.body ?? {}).checklistId;
  if (typeof checklistId !== "number" || !Number.isInteger(checklistId)) {
    return res.status(400).json({ error: "checklistId must be a checklist id." });
  }
  try {
    const today = businessDayKey(new Date(), (await getAppSettings()).timezone);
    const result = await prisma.$transaction((tx) =>
      applyChecklist(tx, caseId, checklistId, { today, by: session.user?.email ?? null }),
    );
    return res.status(201).json(result);
  } catch (err) {
    if (err instanceof ChecklistError) return res.status(err.status).json({ error: err.message });
    logError("POST /api/service/cases/[id]/checklist error", err, { caseId, checklistId });
    return res.status(500).json({ error: "Failed to add the checklist" });
  }
}

export default requirePermission("service.write", handler);
