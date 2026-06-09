// /app/src/pages/api/admin/trade-tiers/index.ts

import { NextApiRequest, NextApiResponse } from "next";
import { Session } from "next-auth";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";

export default requireAuthWithRole(["MANAGER", "ADMIN"], async (req, res, session) => {
  if (req.method === "GET") {
    return handleGet(res);
  }
  if (req.method === "POST") {
    return handlePost(req, res, session);
  }
  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
});

async function handleGet(res: NextApiResponse) {
  const tiers = await prisma.tradeTier.findMany({
    orderBy: { sortOrder: "asc" },
  });
  return res.json(tiers);
}

async function handlePost(req: NextApiRequest, res: NextApiResponse, session: Session) {
  const { name, discountPercent, sortOrder } = req.body;

  if (!name || typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "Name is required" });
  }

  if (discountPercent == null || Number.isNaN(Number(discountPercent))) {
    return res.status(400).json({ error: "Discount percent is required" });
  }

  const discount = Number(discountPercent);
  if (discount < 0 || discount > 100) {
    return res.status(400).json({ error: "Discount must be between 0 and 100" });
  }

  const existing = await prisma.tradeTier.findUnique({ where: { name: name.trim() } });
  if (existing) {
    return res.status(409).json({ error: "A tier with that name already exists" });
  }

  const tier = await prisma.tradeTier.create({
    data: {
      name: name.trim(),
      discountPercent: discount,
      sortOrder: sortOrder != null ? Number(sortOrder) : 0,
      createdBy: session.user?.email || undefined,
    },
  });

  return res.status(201).json(tier);
}
