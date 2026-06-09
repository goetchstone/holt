// /app/src/pages/api/categories/[id].ts

import { prisma } from "@/lib/prisma";
import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";
import { getErrorCode } from "@/lib/errorCode";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const id = Number.parseInt(req.query.id as string);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid category ID" });

  if (req.method === "GET") {
    try {
      const category = await prisma.category.findUnique({
        where: { id },
        include: {
          department: true,
          labelTemplate: true,
          accountGroup: { select: { id: true, name: true } },
        },
      });
      if (!category) return res.status(404).json({ error: "Category not found" });
      return res.status(200).json(category);
    } catch (err) {
      logError("GET /categories/[id] error", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  if (req.method === "PUT") {
    const { name, departmentId, trackInventory, accountGroupId, labelTemplateId } = req.body;

    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "Name is required" });
    }
    if (!departmentId || Number.isNaN(Number.parseInt(departmentId))) {
      return res.status(400).json({ error: "Valid department ID is required" });
    }

    try {
      const updated = await prisma.category.update({
        where: { id },
        data: {
          name,
          departmentId: Number.parseInt(departmentId),
          trackInventory: trackInventory ?? true,
          accountGroupId: accountGroupId ? Number.parseInt(accountGroupId) : null,
          labelTemplateId: labelTemplateId ? Number.parseInt(labelTemplateId) : null,
        },
      });
      return res.status(200).json(updated);
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2025") {
        return res.status(404).json({ error: "Category not found" });
      }
      if (getErrorCode(err) === "P2002") {
        return res
          .status(409)
          .json({ error: `Category "${name}" already exists in this department` });
      }
      logError("PUT /categories/[id] error", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  if (req.method === "DELETE") {
    try {
      await prisma.category.delete({ where: { id } });
      return res.status(204).end();
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2025") {
        return res.status(404).json({ error: "Category not found" });
      }
      if (getErrorCode(err) === "P2003") {
        return res.status(409).json({
          error: "Cannot delete category: it is associated with products or other records.",
        });
      }
      logError("DELETE /categories/[id] error", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  res.setHeader("Allow", ["GET", "PUT", "DELETE"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}
