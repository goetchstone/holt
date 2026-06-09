// /app/src/pages/api/tax/exempt-reasons/[id].ts

import { getErrorCode } from "@/lib/errorCode";
import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

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
