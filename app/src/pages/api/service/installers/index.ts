// /app/src/pages/api/service/installers/index.ts

import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method === "GET") {
    return handleGet(req, res);
  } else if (req.method === "POST") {
    const mutationRole = (session as unknown as { role?: string })?.role;
    if (!["MANAGER", "ADMIN"].includes(mutationRole ?? "")) {
      return res.status(403).json({ error: "Insufficient role for this action" });
    }

    return handlePost(req, res, session.user?.email || null);
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const where: any = {};
  if (req.query.active === "true") {
    where.isActive = true;
  }

  try {
    const installers = await prisma.installer.findMany({
      where,
      include: { staffMember: true },
      orderBy: { name: "asc" },
    });

    return res.status(200).json(installers);
  } catch (error) {
    logError("Error fetching installers", error);
    return res.status(500).json({ error: "Failed to fetch installers" });
  }
}

async function handlePost(req: NextApiRequest, res: NextApiResponse, createdBy: string | null) {
  const { name, phone, email, company, staffMemberId, notes } = req.body;

  if (!name) {
    return res.status(400).json({ error: "name is required" });
  }

  try {
    const installer = await prisma.installer.create({
      data: {
        name,
        phone: phone || undefined,
        email: email || undefined,
        company: company || undefined,
        staffMemberId: staffMemberId ? Number.parseInt(staffMemberId) : undefined,
        notes: notes || undefined,
        createdBy,
      },
      include: { staffMember: true },
    });

    return res.status(201).json(installer);
  } catch (error) {
    logError("Error creating installer", error);
    return res.status(500).json({ error: "Failed to create installer" });
  }
}
