// /app/src/pages/api/tax/groups/[id].ts

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
      const group = await prisma.taxGroup.findUnique({ where: { id } });
      if (!group) return res.status(404).json({ error: "Not found" });
      return res.status(200).json(group);
    } catch (err) {
      logError(`GET /tax/groups/${id} error`, err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  if (req.method === "PUT") {
    const { name, taxBasis, freightTaxable, miscTaxable } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ error: "Name is required" });
    }

    try {
      const updated = await prisma.taxGroup.update({
        where: { id },
        data: {
          name: name.trim(),
          taxBasis: taxBasis || "NET",
          freightTaxable: !!freightTaxable,
          miscTaxable: !!miscTaxable,
        },
      });
      return res.status(200).json(updated);
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2002") {
        return res.status(409).json({ error: `Tax group "${name}" already exists.` });
      }
      if (getErrorCode(err) === "P2025") {
        return res.status(404).json({ error: "Not found" });
      }
      logError(`PUT /tax/groups/${id} error`, err);
      return res.status(500).json({ error: "Failed to update tax group" });
    }
  }

  if (req.method === "DELETE") {
    try {
      const ruleCount = await prisma.taxRule.count({ where: { groupId: id } });
      if (ruleCount > 0) {
        return res.status(409).json({
          error: `Cannot delete: ${ruleCount} tax rule${ruleCount !== 1 ? "s" : ""} reference this group.`,
        });
      }

      await prisma.taxGroup.delete({ where: { id } });
      return res.status(200).json({ success: true });
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2025") {
        return res.status(404).json({ error: "Not found" });
      }
      logError(`DELETE /tax/groups/${id} error`, err);
      return res.status(500).json({ error: "Failed to delete tax group" });
    }
  }

  res.setHeader("Allow", ["GET", "PUT", "DELETE"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}
