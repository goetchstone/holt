// /app/src/pages/api/upboard/roster.ts
//
// Who can be signed in to the Up Board: every active staff member's id, name
// and role, nothing else. The board's Sign In panel used to read GET
// /api/staff, which is "Manage staff" (staff.manage) because it returns
// emails, commission plans and role details, so for everyone else (designers
// included, now that every role lands on the home page) the panel came up
// empty and said "All designers are signed in". This answers to the same key
// as signing someone in (POST /api/upboard/clock-in, staff.self), so it widens
// nothing the board did not already allow.

import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { isModuleEnabled } from "@/lib/modules/requireModule";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!(await isModuleEnabled("upBoard"))) {
    return res.status(404).json({ error: "Module not enabled" });
  }
  try {
    const staff = await prisma.staffMember.findMany({
      where: { isActive: true },
      orderBy: { displayName: "asc" },
      select: { id: true, displayName: true, role: true },
    });
    return res.status(200).json(staff);
  } catch (error) {
    logError("GET /upboard/roster error", error);
    return res.status(500).json({ error: "Failed to load the roster" });
  }
}

export default requirePermission("staff.self", handler);
