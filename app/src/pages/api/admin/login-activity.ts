// /app/src/pages/api/admin/login-activity.ts
//
// ADMIN-only listing of staff with their last-login + last-seen timestamps.
// Powers the /admin/login-activity page so a manager can see who's been
// using the system and roughly who's online right now.
//
// Reads from StaffMember (lastLoginAt / lastSeenAt populated by the
// NextAuth jwt callback). No PII beyond what already lives on
// /admin/setup/staff. Inactive staff are excluded by default but can be
// included via ?includeInactive=true.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import type { LoginActivityRow, LoginActivityResponse } from "@/lib/loginActivity";

export default requireAuthWithRole(["ADMIN"], async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const includeInactive = req.query.includeInactive === "true";
    const staff = await prisma.staffMember.findMany({
      where: includeInactive ? undefined : { isActive: true },
      select: {
        id: true,
        displayName: true,
        email: true,
        role: true,
        isActive: true,
        lastLoginAt: true,
        lastSeenAt: true,
      },
      // Most-recently-seen first; never-seen users sort last.
      orderBy: [{ lastSeenAt: "desc" }, { displayName: "asc" }],
    });

    const rows: LoginActivityRow[] = staff.map((s) => ({
      id: s.id,
      displayName: s.displayName,
      email: s.email,
      role: s.role,
      isActive: s.isActive,
      lastLoginAt: s.lastLoginAt ? s.lastLoginAt.toISOString() : null,
      lastSeenAt: s.lastSeenAt ? s.lastSeenAt.toISOString() : null,
    }));

    const body: LoginActivityResponse = {
      staff: rows,
      generatedAt: new Date().toISOString(),
    };
    return res.status(200).json(body);
  } catch (err) {
    logError("/api/admin/login-activity failed", err);
    return res.status(500).json({ error: "Failed to load login activity" });
  }
});
