// /app/src/pages/api/labels/index.ts

import { prisma } from "@/lib/prisma";
import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";
import { getErrorCode } from "@/lib/errorCode";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const { method } = req;

  if (method === "GET") {
    try {
      const page = Number.parseInt(req.query.page as string) || 1;
      const limit = Number.parseInt(req.query.limit as string) || 10;
      const search = (req.query.search as string)?.trim() || "";

      const skip = (page - 1) * limit;

      const where = search
        ? {
            OR: [
              { name: { contains: search, mode: "insensitive" as const } },
              { context: { contains: search, mode: "insensitive" as const } },
              { tagSize: { contains: search, mode: "insensitive" as const } },
            ],
          }
        : {};

      const [templates, total] = await Promise.all([
        prisma.labelTemplate.findMany({
          where,
          skip,
          take: limit,
          orderBy: { created: "desc" },
        }),
        prisma.labelTemplate.count({ where }),
      ]);

      return res.status(200).json({ templates, total });
    } catch (err) {
      logError("GET /labels error", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  // POST (Create) a label template
  if (method === "POST") {
    const { name, context, tagSize, zplTemplate } = req.body;
    if (!name || !context || !tagSize || !zplTemplate) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    try {
      const created = await prisma.labelTemplate.create({
        data: { name, context, tagSize, zplTemplate },
      });
      return res.status(201).json(created);
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2002") {
        // Unique constraint failed
        return res
          .status(409)
          .json({ error: `Label template with name '${name}' already exists.` });
      }
      logError("POST /labels error", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  // PUT (Update) a label template (will be handled by [id]/index.ts, kept here for completeness but not used by modal direct PUT)
  if (method === "PUT") {
    const { id, name, context, tagSize, zplTemplate } = req.body;
    if (!id || !name || !context || !tagSize || !zplTemplate) {
      return res.status(400).json({ error: "Missing fields for update" });
    }
    try {
      const updated = await prisma.labelTemplate.update({
        where: { id: Number(id) },
        data: { name, context, tagSize, zplTemplate },
      });
      return res.status(200).json(updated);
    } catch (err) {
      logError("PUT /labels error", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  // DELETE a label template (will be handled by [id]/index.ts)
  if (method === "DELETE") {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "Missing ID" });
    try {
      await prisma.labelTemplate.delete({ where: { id: Number(id) } });
      return res.status(204).end();
    } catch (err) {
      logError("DELETE /labels error", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
