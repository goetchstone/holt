// /app/src/pages/api/types/[id]/index.ts

import { prisma } from "@/lib/prisma";
import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";
import { getErrorCode } from "@/lib/errorCode";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const typeId = Number.parseInt(req.query.id as string);

  if (Number.isNaN(typeId)) {
    return res.status(400).json({ error: "Invalid type ID" });
  }

  // GET a single type
  if (req.method === "GET") {
    try {
      const type = await prisma.type.findUnique({
        where: { id: typeId },
        include: { category: true },
      });
      if (!type) {
        return res.status(404).json({ error: "Type not found" });
      }
      return res.status(200).json(type);
    } catch (err) {
      logError("GET /types/[id] error", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  // PUT (Update) a type
  if (req.method === "PUT") {
    const { name, categoryId } = req.body;

    if (!name || typeof name !== "string" || !categoryId || Number.isNaN(categoryId)) {
      return res.status(400).json({ error: "Invalid input" });
    }

    try {
      const updated = await prisma.type.update({
        where: { id: typeId },
        data: {
          name,
          categoryId: Number.parseInt(categoryId),
        },
      });
      return res.status(200).json(updated);
    } catch (err) {
      logError("PUT /types/[id] error", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  // DELETE a type
  if (req.method === "DELETE") {
    try {
      await prisma.type.delete({
        where: { id: typeId },
      });
      return res.status(204).end(); // No content for successful deletion
    } catch (err: unknown) {
      // Check if the error is due to a foreign key constraint (type being used elsewhere)
      if (getErrorCode(err) === "P2003") {
        // Prisma Foreign Key Constraint Failed
        return res.status(409).json({
          error: "Cannot delete type: It is currently associated with products or other records.",
        });
      }
      logError("DELETE /types/[id] error", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  res.setHeader("Allow", ["GET", "PUT", "DELETE"]);
  res.status(405).end(`Method ${req.method} Not Allowed`);
}
