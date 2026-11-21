// /app/src/pages/api/leads/needs-attention.ts
//
// Three counts for the "Needs Attention" strip at the top of /leads, gated on
// "View marketing" (marketing.read), whose description names them. The board
// asks for them only when the viewer holds that key; anyone else sees the board
// without the strip.

import type { NextApiRequest, NextApiResponse } from "next";
import { requirePermission } from "@/lib/auth/requireAuth";
import { computeNeedsAttention } from "@/lib/leadHousekeeping";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).end();

  const counts = await computeNeedsAttention();
  return res.status(200).json(counts);
}

export default requirePermission("marketing.read", handler);
