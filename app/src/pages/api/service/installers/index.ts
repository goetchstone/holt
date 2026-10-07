// /app/src/pages/api/service/installers/index.ts

import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method === "GET") {
    return handleGet(req, res);
  } else if (req.method === "POST") {
    return handlePost(req, res, session.user?.email || null);
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}

export default requireAuthWithRole(["MANAGER", "ADMIN"], handler);

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
