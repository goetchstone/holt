// /app/src/pages/api/staff/me.ts
//
// Returns the current user's StaffMember record. Used by report pages
// to determine the caller's display name and role without loading the
// full staff list.

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const session = await getServerSession(req, res, authOptions);
  if (!session?.user) return res.status(401).json({ error: "Unauthorized" });

  const userId = (session.user as { id?: string }).id;
  if (!userId) return res.status(400).json({ error: "No user ID in session" });

  const staff = await prisma.staffMember.findFirst({
    where: { userId },
    select: { id: true, displayName: true, role: true },
  });

  if (!staff) return res.status(404).json({ error: "No staff record linked to this account" });

  return res.status(200).json(staff);
}
