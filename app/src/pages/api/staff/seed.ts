// /app/src/pages/api/staff/seed.ts
// POST /api/staff/seed — seed a small set of example staff members.
// Replace or extend KNOWN_STAFF with your own roster, or create staff via the
// admin UI. Existing members (matched by displayName) are left untouched.

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";

const KNOWN_STAFF = [
  { displayName: "Jordan Lee", defaultStore: "Main Showroom", role: "DESIGNER" },
  { displayName: "Casey Morgan", defaultStore: "Main Showroom", role: "DESIGNER" },
  { displayName: "Riley Chen", defaultStore: "West Showroom", role: "DESIGNER" },
  { displayName: "Sam Rivera", defaultStore: "Main Showroom", role: "MANAGER" },
  { displayName: "Taylor Brooks", defaultStore: "B2B", role: "MANAGER" },
] as const;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  let created = 0;
  let existing = 0;

  for (const staff of KNOWN_STAFF) {
    const exists = await prisma.staffMember.findFirst({
      where: { displayName: staff.displayName },
    });
    if (exists) {
      existing++;
      continue;
    }
    await prisma.staffMember.create({
      data: {
        displayName: staff.displayName,
        defaultStore: staff.defaultStore,
        role: staff.role as any,
      },
    });
    created++;
  }

  return res.json({ created, existing, total: KNOWN_STAFF.length });
}
