// /app/src/pages/api/service/checklists/index.ts
//
// GAP-11: the store's service checklists (lib/service/checklists.ts). GET is the
// active list a case can be given, so anyone who works service cases can read
// it; GET ?all=1 (with every step) and POST are Settings > Service, gated like
// that page: admin.config. Per-method gates follow referral-sources/index.ts.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { ChecklistError, createChecklist, listChecklists } from "@/lib/service/checklists";
import type { ChecklistOption, ChecklistRow } from "@/lib/service/checklistsShared";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    if (req.query.all) return requirePermission("admin.config", handleAll)(req, res);
    return requirePermission({ anyOf: ["service.write", "admin.config"] }, handleActive)(req, res);
  }
  if (req.method === "POST") return requirePermission("admin.config", handlePost)(req, res);
  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

function asRow(c: Awaited<ReturnType<typeof listChecklists>>[number]): ChecklistRow {
  return {
    id: c.id,
    name: c.name,
    isActive: c.isActive,
    sortOrder: c.sortOrder,
    steps: c.steps.map(({ title, description, dueAfterDays }) => ({
      title,
      description,
      dueAfterDays,
    })),
  };
}

export async function handleActive(_req: NextApiRequest, res: NextApiResponse) {
  try {
    const checklists = await listChecklists(prisma, { activeOnly: true });
    const options: ChecklistOption[] = checklists.map((c) => ({
      id: c.id,
      name: c.name,
      stepCount: c.steps.length,
    }));
    return res.status(200).json(options);
  } catch (err) {
    logError("GET /api/service/checklists error", err);
    return res.status(500).json({ error: "Failed to load checklists" });
  }
}

export async function handleAll(_req: NextApiRequest, res: NextApiResponse) {
  try {
    const checklists = await listChecklists(prisma);
    return res.status(200).json(checklists.map(asRow));
  } catch (err) {
    logError("GET /api/service/checklists?all error", err);
    return res.status(500).json({ error: "Failed to load checklists" });
  }
}

export async function handlePost(req: NextApiRequest, res: NextApiResponse, session: Session) {
  try {
    const checklist = await prisma.$transaction((tx) =>
      createChecklist(tx, req.body ?? {}, session.user?.email ?? null),
    );
    return res.status(201).json(asRow(checklist));
  } catch (err) {
    if (err instanceof ChecklistError) return res.status(err.status).json({ error: err.message });
    logError("POST /api/service/checklists error", err);
    return res.status(500).json({ error: "Failed to add the checklist" });
  }
}
