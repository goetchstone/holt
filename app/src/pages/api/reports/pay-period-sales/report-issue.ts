// /app/src/pages/api/reports/pay-period-sales/report-issue.ts
//
// A designer flags that their pay-period numbers look wrong instead of
// confirming. Raises a flag on the manager review grid (does NOT lock
// the period). A manager/SUPER_ADMIN can report on a designer's behalf
// by passing staffMemberId. No period-ended gate — a designer can flag
// a problem at any time, including mid-period.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { activeStaffRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { reportPayPeriodIssue, periodFromStartParam } from "@/lib/payPeriodConfirmationService";
import { logError } from "@/lib/logger";

const PRIVILEGED_ROLES = new Set(["MANAGER", "ADMIN", "SUPER_ADMIN"]);

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!session.user) return res.status(401).json({ error: "Unauthorized" });

  // The requireAuthWithRole(["SUPER_ADMIN"]) gate below already enforces
  // "Tabled 2026-05-29 (owner direction): SUPER_ADMIN-only" off a fresh DB
  // role, so isPrivileged is always true past the gate -- kept as-is
  // (unchanged business logic) rather than simplified away.
  const role = await activeStaffRole(session as { user?: { id?: string | null } | null });
  const userId = (session.user as { id?: string }).id;
  const isPrivileged = role !== null && PRIVILEGED_ROLES.has(role);
  const email = session.user.email ?? "unknown";

  const period = periodFromStartParam(req.body?.periodStart);
  if (!period) {
    return res.status(400).json({ error: "periodStart (YYYY-MM-DD) is required" });
  }

  const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
  if (!note) {
    return res.status(400).json({ error: "Describe what looks wrong (a note is required)" });
  }

  try {
    // Resolve the designer raising the issue. Designer = self.
    // Privileged may pass staffMemberId to flag on someone's behalf.
    let staffMemberId: number | null = null;
    if (isPrivileged && typeof req.body?.staffMemberId === "number") {
      staffMemberId = req.body.staffMemberId;
    } else if (userId) {
      const self = await prisma.staffMember.findFirst({
        where: { userId },
        select: { id: true },
      });
      staffMemberId = self?.id ?? null;
    }

    if (!staffMemberId) {
      return res.status(403).json({ error: "No staff record to report an issue for" });
    }

    const result = await reportPayPeriodIssue({
      staffMemberId,
      period,
      note,
      reportedBy: email,
    });

    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    logError("POST /api/reports/pay-period-sales/report-issue failed", err);
    return res.status(500).json({ error: "Failed to report issue" });
  }
}

// SUPER_ADMIN excluded from the ADMIN bucket deliberately (owner direction,
// 2026-05-29) -- do not widen to ["ADMIN"], which would also admit ADMIN.
export default requireAuthWithRole(["SUPER_ADMIN"], handler);
