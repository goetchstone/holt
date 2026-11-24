// /app/src/pages/api/service/installers/index.ts
//
// The installer roster. Adding an installer (POST) is setup, from Admin >
// Service > Installers: "Set up service" (service.setup), or "Change settings",
// the key that screen opens on. The list (GET) also fills the Service dispatch
// board's installer picker, which only someone who may schedule an
// appointment can use (dispatch/[id].ts PUT, "Operate warehouse"), so GET
// admits that key too.

import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
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

const readGate = requirePermission(
  { anyOf: ["service.setup", "admin.settings", "warehouse.operate"] },
  handler,
);
const writeGate = requirePermission({ anyOf: ["service.setup", "admin.settings"] }, handler);

export default async function route(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") return readGate(req, res);
  return writeGate(req, res);
}

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const where: any = {};
  if (req.query.active === "true") {
    where.isActive = true;
  }

  try {
    const installers = await prisma.installer.findMany({
      where,
      include: { staffMember: { select: { id: true, displayName: true } } },
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
      include: { staffMember: { select: { id: true, displayName: true } } },
    });

    return res.status(201).json(installer);
  } catch (error) {
    logError("Error creating installer", error);
    return res.status(500).json({ error: "Failed to create installer" });
  }
}
