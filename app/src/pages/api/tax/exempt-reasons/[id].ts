// /app/src/pages/api/tax/exempt-reasons/[id].ts

import { getErrorCode } from "@/lib/errorCode";
import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { auditActor, auditLog } from "@/lib/audit";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  const id = Number.parseInt(req.query.id as string);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

  if (req.method === "GET") {
    try {
      const reason = await prisma.taxExemptReason.findUnique({ where: { id } });
      if (!reason) return res.status(404).json({ error: "Not found" });
      return res.status(200).json(reason);
    } catch (err) {
      logError("GET tax-exempt-reason failed", err, { id });
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  if (req.method === "PUT") {
    const { name, description } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ error: "Name is required" });
    }

    try {
      const updated = await prisma.taxExemptReason.update({
        where: { id },
        data: {
          name: name.trim(),
          description: description?.trim() || null,
        },
      });
      await auditLog("TAX_CHANGED", auditActor(session), {
        summary: `Tax exemption reason ${id} changed`,
      });
      return res.status(200).json(updated);
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2002") {
        return res.status(409).json({ error: `Exempt reason "${name}" already exists.` });
      }
      if (getErrorCode(err) === "P2025") {
        return res.status(404).json({ error: "Not found" });
      }
      logError("PUT tax-exempt-reason failed", err, { id });
      return res.status(500).json({ error: "Failed to update exempt reason" });
    }
  }

  if (req.method === "DELETE") {
    try {
      const usage = await prisma.customer.count({ where: { taxExemptReasonId: id } });
      if (usage > 0) {
        return res.status(409).json({
          error: `Cannot delete: ${usage} customer${usage !== 1 ? "s" : ""} use this exempt reason.`,
        });
      }

      await prisma.taxExemptReason.delete({ where: { id } });
      await auditLog("TAX_CHANGED", auditActor(session), {
        summary: `Tax exemption reason ${id} deleted`,
      });
      return res.status(200).json({ success: true });
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2025") {
        return res.status(404).json({ error: "Not found" });
      }
      logError("DELETE tax-exempt-reason failed", err, { id });
      return res.status(500).json({ error: "Failed to delete exempt reason" });
    }
  }

  res.setHeader("Allow", ["GET", "PUT", "DELETE"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}

export default requirePermission("admin.settings", handler);
