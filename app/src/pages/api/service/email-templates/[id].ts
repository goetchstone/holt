// /app/src/pages/api/service/email-templates/[id].ts

import { getErrorCode } from "@/lib/errorCode";
import { prisma } from "@/lib/prisma";
import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const id = Number.parseInt(req.query.id as string);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid template ID" });

  if (req.method === "GET") {
    try {
      const template = await prisma.emailTemplate.findUnique({ where: { id } });
      if (!template) {
        return res.status(404).json({ error: "Template not found" });
      }
      return res.status(200).json(template);
    } catch (err) {
      logError("GET /service/email-templates/[id] error", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  const role = (session as any)?.role;
  if (role !== "MANAGER" && role !== "ADMIN") {
    return res.status(403).json({ error: "Manager role required" });
  }

  if (req.method === "PUT") {
    const { name, subject, body, category, isActive } = req.body;

    try {
      const template = await prisma.emailTemplate.update({
        where: { id },
        data: {
          ...(name !== undefined && { name: name.trim() }),
          ...(subject !== undefined && { subject: subject.trim() }),
          ...(body !== undefined && { body: body.trim() }),
          ...(category !== undefined && { category: category.trim() }),
          ...(isActive !== undefined && { isActive }),
          updatedBy: session.user?.email || null,
        },
      });
      return res.status(200).json(template);
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2025") {
        return res.status(404).json({ error: "Template not found" });
      }
      if (getErrorCode(err) === "P2002") {
        return res.status(409).json({ error: `Template "${name?.trim()}" already exists` });
      }
      logError("PUT /service/email-templates/[id] error", err);
      return res.status(500).json({ error: "Failed to update template" });
    }
  }

  if (req.method === "DELETE") {
    try {
      await prisma.emailTemplate.delete({ where: { id } });
      return res.status(204).end();
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2025") {
        return res.status(404).json({ error: "Template not found" });
      }
      logError("DELETE /service/email-templates/[id] error", err);
      return res.status(500).json({ error: "Failed to delete template" });
    }
  }

  res.setHeader("Allow", ["GET", "PUT", "DELETE"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}
