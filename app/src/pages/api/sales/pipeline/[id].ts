// /app/src/pages/api/sales/pipeline/[id].ts
//
// PATCH: archive or restore a single quote from the pipeline.
// Designers can only act on their own quotes; managers can act on any.
// Optional fields lock the archived quote to a replacement (for "Updated Quote" /
// "Duplicate" reasons) so conversion reports can roll them together.

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import {
  ARCHIVE_REASONS,
  isValidArchiveReason,
  validateArchiveReplacementRequirement,
} from "@/lib/quoteArchive";

interface ArchiveBody {
  archived: boolean;
  note?: string;
  reason?: string;
  replacedByOrderId?: number | null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "PATCH") return res.status(405).json({ error: "Method not allowed" });

  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.email) return res.status(401).json({ error: "Unauthorized" });

  const id = Number.parseInt(req.query.id as string, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid id" });

  const { archived, note, reason, replacedByOrderId } = req.body as ArchiveBody;
  if (typeof archived !== "boolean") return res.status(400).json({ error: "archived is required" });

  if (archived && reason !== undefined && !isValidArchiveReason(reason)) {
    return res.status(400).json({ error: `reason must be one of: ${ARCHIVE_REASONS.join(", ")}` });
  }

  if (
    replacedByOrderId !== undefined &&
    replacedByOrderId !== null &&
    typeof replacedByOrderId !== "number"
  ) {
    return res.status(400).json({ error: "replacedByOrderId must be a number or null" });
  }

  // Enforce: archiving with "Updated Quote" / "Duplicate" requires the
  // replacement to be linked. Otherwise we end up with rows like
  // SO-38985 (Issue #129) -- archived with reason but no replacement,
  // invisible from any pipeline view.
  if (archived) {
    const replCheck = validateArchiveReplacementRequirement(reason, replacedByOrderId);
    if (!replCheck.ok) {
      return res.status(400).json({ error: replCheck.error });
    }
  }

  const staff = await prisma.staffMember.findUnique({
    where: { email: session.user.email },
    select: { id: true, displayName: true, role: true },
  });
  // Deny when no StaffMember record exists. The earlier `|| !staff`
  // branch granted any Google account without a staff record manager-level
  // privileges on quote archiving.
  if (!staff) {
    return res.status(403).json({ error: "Staff record required" });
  }
  const isManager =
    staff.role === "MANAGER" || staff.role === "ADMIN" || staff.role === "SUPER_ADMIN";

  const order = await prisma.salesOrder.findUnique({
    where: { id },
    select: { id: true, status: true, salesPersonId: true, salesperson: true, customerId: true },
  });
  if (!order) return res.status(404).json({ error: "Quote not found" });
  if (order.status !== "QUOTE")
    return res.status(400).json({ error: "Only quotes can be archived" });

  // Designers may only archive their own quotes
  if (!isManager) {
    const isOwner =
      order.salesPersonId === staff.id ||
      (order.salesperson?.toLowerCase().includes(staff.displayName.toLowerCase()) ?? false);
    if (!isOwner) return res.status(403).json({ error: "Forbidden" });
  }

  // If archiving with a replacement, verify it exists and belongs to the same customer
  if (archived && replacedByOrderId) {
    if (replacedByOrderId === id) {
      return res.status(400).json({ error: "A quote cannot replace itself" });
    }
    const replacement = await prisma.salesOrder.findUnique({
      where: { id: replacedByOrderId },
      select: { id: true, customerId: true },
    });
    if (!replacement) return res.status(400).json({ error: "Replacement order not found" });
    if (replacement.customerId !== order.customerId) {
      return res.status(400).json({ error: "Replacement must belong to the same customer" });
    }
  }

  const updated = await prisma.salesOrder.update({
    where: { id },
    data: {
      pipelineArchivedAt: archived ? new Date() : null,
      pipelineNote: archived ? note?.trim() || null : null,
      archiveReason: archived ? (reason ?? null) : null,
      replacedByOrderId: archived ? (replacedByOrderId ?? null) : null,
      updatedBy: session.user.email,
    },
    select: {
      id: true,
      pipelineArchivedAt: true,
      pipelineNote: true,
      archiveReason: true,
      replacedByOrderId: true,
    },
  });

  return res.status(200).json(updated);
}
