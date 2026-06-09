// /app/src/pages/api/leads/needs-attention.ts
//
// Three counts for the "Needs Attention" strip at the top of /leads.
// MANAGER/ADMIN only — designers see the board without the strip.

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { computeNeedsAttention } from "@/lib/leadHousekeeping";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.email) return res.status(401).json({ error: "Unauthorized" });
  if (req.method !== "GET") return res.status(405).end();

  const role = (session as { role?: string }).role;
  if (role !== "MANAGER" && role !== "ADMIN") {
    return res.status(403).json({ error: "Manager or Admin role required" });
  }

  const counts = await computeNeedsAttention();
  return res.status(200).json(counts);
}
