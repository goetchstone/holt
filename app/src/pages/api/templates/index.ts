// /app/src/pages/api/templates/index.ts

import { requirePermission } from "@/lib/auth/requireAuth";
import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).end();
  const templates = await prisma.labelTemplate.findMany();
  res.status(200).json(templates);
}

export default requirePermission("admin.settings", handler);
