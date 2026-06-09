// /app/src/pages/api/departments/[id]/index.ts

import { prisma } from "@/lib/prisma";
import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";
import { getErrorCode } from "@/lib/errorCode";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const departmentId = Number.parseInt(req.query.id as string);

  if (Number.isNaN(departmentId)) {
    return res.status(400).json({ error: "Invalid department ID" });
  }

  // GET a single department
  if (req.method === "GET") {
    try {
      const department = await prisma.department.findUnique({
        where: { id: departmentId },
      });
      if (!department) {
        return res.status(404).json({ error: "Department not found" });
      }
      return res.status(200).json(department);
    } catch (err) {
      logError("GET /departments/[id] error", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  // PUT (Update) a department
  if (req.method === "PUT") {
    const { name } = req.body;

    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "Invalid name" });
    }

    try {
      const updated = await prisma.department.update({
        where: { id: departmentId },
        data: { name },
      });
      return res.status(200).json(updated);
    } catch (err: unknown) {
      // Check for unique constraint violation (P2002 is unique constraint failed)
      if (getErrorCode(err) === "P2002") {
        return res.status(409).json({ error: `Department with name '${name}' already exists.` });
      }
      logError("PUT /departments/[id] error", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  // DELETE a department
  if (req.method === "DELETE") {
    try {
      await prisma.department.delete({
        where: { id: departmentId },
      });
      return res.status(204).end(); // No content for successful deletion
    } catch (err: unknown) {
      // Check if the error is due to a foreign key constraint (department being used elsewhere)
      if (getErrorCode(err) === "P2003") {
        // Prisma Foreign Key Constraint Failed
        return res.status(409).json({
          error:
            "Cannot delete department: It is currently associated with categories or other records.",
        });
      }
      logError("DELETE /departments/[id] error", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  res.setHeader("Allow", ["GET", "PUT", "DELETE"]);
  res.status(405).end(`Method ${req.method} Not Allowed`);
}
