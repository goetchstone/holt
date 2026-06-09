// /app/src/pages/api/time-entries/index.ts
//
// Time entries collection. Any signed-in staff member can log + list their own
// time; ADMIN/MANAGER/SUPER_ADMIN can view the whole team (?all=true) or filter
// to one person (?staffMemberId=). The duration is parsed to minutes on the
// client; this endpoint validates the integer minutes (CLAUDE.md rule 14).

import type { NextApiRequest, NextApiResponse } from "next";
import type { Prisma } from "@prisma/client";
import { requireAuth } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { DEFAULT_ORG_ID } from "@/lib/appSettings";
import { parseTimeEntryCreateInput } from "@/lib/timeEntries/requestBody";
import { getErrorMessage } from "@/lib/toastError";
import { logError } from "@/lib/logger";

const CAN_SEE_ALL = new Set(["SUPER_ADMIN", "ADMIN", "MANAGER"]);

async function resolveStaff(userId: string | undefined) {
  if (!userId) return null;
  return prisma.staffMember.findFirst({ where: { userId }, select: { id: true, role: true } });
}

export default requireAuth(async (req: NextApiRequest, res: NextApiResponse, session) => {
  const staff = await resolveStaff((session.user as { id?: string }).id);
  if (!staff) return res.status(403).json({ error: "Only staff can track time" });
  const privileged = CAN_SEE_ALL.has(staff.role);

  if (req.method === "GET") {
    const where: Prisma.TimeEntryWhereInput = { organizationId: DEFAULT_ORG_ID };

    // Scope to the requester unless a privileged user asks for all / someone else.
    if (privileged && req.query.all === "true") {
      // no staff filter
    } else if (privileged && typeof req.query.staffMemberId === "string") {
      where.staffMemberId = Number(req.query.staffMemberId);
    } else {
      where.staffMemberId = staff.id;
    }

    if (typeof req.query.customerId === "string") where.customerId = Number(req.query.customerId);

    const from = typeof req.query.from === "string" ? new Date(req.query.from) : null;
    const to = typeof req.query.to === "string" ? new Date(req.query.to) : null;
    if (from && !Number.isNaN(from.getTime()))
      where.date = { ...(where.date as object), gte: from };
    if (to && !Number.isNaN(to.getTime())) where.date = { ...(where.date as object), lte: to };

    const entries = await prisma.timeEntry.findMany({
      where,
      orderBy: [{ date: "desc" }, { created: "desc" }],
      select: {
        id: true,
        description: true,
        minutes: true,
        date: true,
        isBillable: true,
        billedAt: true,
        staffMember: { select: { id: true, displayName: true } },
        customer: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    return res.status(200).json({ entries });
  }

  if (req.method === "POST") {
    try {
      const input = parseTimeEntryCreateInput(req.body);
      // Only privileged users may attribute time to another staff member.
      const staffMemberId = privileged && input.staffMemberId ? input.staffMemberId : staff.id;

      const entry = await prisma.timeEntry.create({
        data: {
          organizationId: DEFAULT_ORG_ID,
          staffMemberId,
          customerId: input.customerId ?? null,
          description: input.description,
          minutes: input.minutes,
          date: input.date,
          isBillable: input.isBillable ?? true,
          createdBy: session.user?.email ?? null,
        },
        select: { id: true },
      });
      return res.status(201).json({ entry });
    } catch (err: unknown) {
      logError("Time entry create failed", err);
      return res.status(400).json({ error: getErrorMessage(err, "Could not save time entry") });
    }
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).json({ error: "Method not allowed" });
});
