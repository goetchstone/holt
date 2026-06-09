// /app/src/pages/api/time-entries/[id].ts
//
// Edit/delete a single time entry. The owner can change their own entries;
// ADMIN/MANAGER/SUPER_ADMIN can change anyone's. `billed` toggles the billedAt
// stamp.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Prisma } from "@prisma/client";
import { requireAuth } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { DEFAULT_ORG_ID } from "@/lib/appSettings";
import { parseTimeEntryUpdateInput } from "@/lib/timeEntries/requestBody";
import { getErrorMessage } from "@/lib/toastError";
import { logError } from "@/lib/logger";

const CAN_SEE_ALL = new Set(["SUPER_ADMIN", "ADMIN", "MANAGER"]);

export default requireAuth(async (req: NextApiRequest, res: NextApiResponse, session) => {
  const id = Number(req.query.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });

  const userId = (session.user as { id?: string }).id;
  const staff = userId
    ? await prisma.staffMember.findFirst({ where: { userId }, select: { id: true, role: true } })
    : null;
  if (!staff) return res.status(403).json({ error: "Only staff can track time" });

  const entry = await prisma.timeEntry.findFirst({
    where: { id, organizationId: DEFAULT_ORG_ID },
    select: { id: true, staffMemberId: true },
  });
  if (!entry) return res.status(404).json({ error: "Time entry not found" });

  const isOwner = entry.staffMemberId === staff.id;
  if (!isOwner && !CAN_SEE_ALL.has(staff.role)) {
    return res.status(403).json({ error: "You can only change your own time entries" });
  }

  if (req.method === "PATCH") {
    try {
      const input = parseTimeEntryUpdateInput(req.body);
      const data: Prisma.TimeEntryUpdateInput = { updatedBy: session.user?.email ?? null };
      if (input.description !== undefined) data.description = input.description;
      if (input.minutes !== undefined) data.minutes = input.minutes;
      if (input.date !== undefined) data.date = input.date;
      if (input.isBillable !== undefined) data.isBillable = input.isBillable;
      if (input.billed !== undefined) data.billedAt = input.billed ? new Date() : null;
      if ("customerId" in input) {
        data.customer =
          input.customerId == null ? { disconnect: true } : { connect: { id: input.customerId } };
      }

      const updated = await prisma.timeEntry.update({ where: { id }, data, select: { id: true } });
      return res.status(200).json({ entry: updated });
    } catch (err: unknown) {
      logError("Time entry update failed", err);
      return res.status(400).json({ error: getErrorMessage(err, "Could not update time entry") });
    }
  }

  if (req.method === "DELETE") {
    await prisma.timeEntry.delete({ where: { id } });
    return res.status(204).end();
  }

  res.setHeader("Allow", ["PATCH", "DELETE"]);
  return res.status(405).json({ error: "Method not allowed" });
});
