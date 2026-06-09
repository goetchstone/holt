// /app/src/pages/api/staff/index.ts
// GET  /api/staff — list staff (active by default; ?all=true for all, ?isDesigner=true for flagged)
// POST /api/staff — create a new staff member

import type { NextApiRequest, NextApiResponse } from "next";
import type { Prisma } from "@prisma/client";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const where: Prisma.StaffMemberWhereInput = {};
  if (req.query.all !== "true") where.isActive = true;
  if (req.query.isDesigner === "true") where.isDesigner = true;
  const staff = await prisma.staffMember.findMany({
    where,
    orderBy: { displayName: "asc" },
    include: { user: { select: { email: true, name: true, image: true } } },
  });
  return res.json(staff);
}

async function handlePost(req: NextApiRequest, res: NextApiResponse) {
  const { displayName, email, role, defaultStore, isDesigner } = req.body;
  if (!displayName) return res.status(400).json({ error: "displayName required" });

  const resolvedRole = role || "DESIGNER";
  try {
    const member = await prisma.staffMember.create({
      data: {
        displayName,
        email: email || null,
        role: resolvedRole,
        defaultStore: defaultStore || null,
        // Default the report-visibility flag from the role unless set explicitly.
        isDesigner: typeof isDesigner === "boolean" ? isDesigner : resolvedRole === "DESIGNER",
      },
      include: { user: { select: { email: true, name: true, image: true } } },
    });
    return res.status(201).json(member);
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") {
      return res.status(409).json({ error: "Email already in use by another staff member" });
    }
    throw err;
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method === "GET") return handleGet(req, res);
  if (req.method === "POST") return handlePost(req, res);
  return res.status(405).json({ error: "Method not allowed" });
}
