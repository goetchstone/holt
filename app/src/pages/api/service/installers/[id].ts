// /app/src/pages/api/service/installers/[id].ts

import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const id = Number.parseInt(req.query.id as string);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid installer ID" });

  if (req.method === "GET") {
    return handleGet(id, res);
  } else if (req.method === "PUT") {
    const mutationRole = (session as unknown as { role?: string })?.role;
    if (!["MANAGER", "ADMIN"].includes(mutationRole ?? "")) {
      return res.status(403).json({ error: "Insufficient role for this action" });
    }

    return handlePut(id, req, res, session.user?.email || null);
  }

  res.setHeader("Allow", ["GET", "PUT"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}

async function handleGet(id: number, res: NextApiResponse) {
  try {
    const installer = await prisma.installer.findUnique({
      where: { id },
      include: { staffMember: true },
    });

    if (!installer) return res.status(404).json({ error: "Installer not found" });

    return res.status(200).json(installer);
  } catch (error) {
    logError("Error fetching installer", error);
    return res.status(500).json({ error: "Failed to fetch installer" });
  }
}

async function handlePut(
  id: number,
  req: NextApiRequest,
  res: NextApiResponse,
  updatedBy: string | null,
) {
  const { name, phone, email, company, staffMemberId, notes, isActive } = req.body;

  try {
    const installer = await prisma.installer.update({
      where: { id },
      data: {
        name: name !== undefined ? name : undefined,
        phone: phone !== undefined ? phone : undefined,
        email: email !== undefined ? email : undefined,
        company: company !== undefined ? company : undefined,
        staffMemberId:
          staffMemberId !== undefined
            ? staffMemberId
              ? Number.parseInt(staffMemberId)
              : null
            : undefined,
        notes: notes !== undefined ? notes : undefined,
        isActive: isActive !== undefined ? isActive : undefined,
        updatedBy,
      },
      include: { staffMember: true },
    });

    return res.status(200).json(installer);
  } catch (error) {
    logError("Error updating installer", error);
    return res.status(500).json({ error: "Failed to update installer" });
  }
}
