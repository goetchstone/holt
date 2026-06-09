// /app/src/pages/api/admin/trade-tiers/[id].ts

import { NextApiRequest, NextApiResponse } from "next";
import { Session } from "next-auth";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";

export default requireAuthWithRole(["MANAGER", "ADMIN"], async (req, res, session) => {
  const id = Number.parseInt(req.query.id as string);
  if (Number.isNaN(id)) {
    return res.status(400).json({ error: "Invalid tier ID" });
  }

  if (req.method === "PUT") {
    return handlePut(id, req, res, session);
  }
  if (req.method === "DELETE") {
    return handleDelete(id, res, session);
  }
  res.setHeader("Allow", "PUT, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
});

async function handlePut(id: number, req: NextApiRequest, res: NextApiResponse, session: Session) {
  const existing = await prisma.tradeTier.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: "Tier not found" });
  }

  const { name, discountPercent, sortOrder, isActive } = req.body;

  if (name != null && (typeof name !== "string" || !name.trim())) {
    return res.status(400).json({ error: "Name cannot be empty" });
  }

  if (discountPercent != null) {
    const discount = Number(discountPercent);
    if (Number.isNaN(discount) || discount < 0 || discount > 100) {
      return res.status(400).json({ error: "Discount must be between 0 and 100" });
    }
  }

  // Check uniqueness if name is being changed
  if (name && name.trim() !== existing.name) {
    const duplicate = await prisma.tradeTier.findUnique({ where: { name: name.trim() } });
    if (duplicate) {
      return res.status(409).json({ error: "A tier with that name already exists" });
    }
  }

  const tier = await prisma.tradeTier.update({
    where: { id },
    data: {
      ...(name != null && { name: name.trim() }),
      ...(discountPercent != null && { discountPercent: Number(discountPercent) }),
      ...(sortOrder != null && { sortOrder: Number(sortOrder) }),
      ...(isActive != null && { isActive }),
      updatedBy: session.user?.email || undefined,
    },
  });

  return res.json(tier);
}

async function handleDelete(id: number, res: NextApiResponse, session: Session) {
  const existing = await prisma.tradeTier.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: "Tier not found" });
  }

  // Soft delete by deactivating
  const tier = await prisma.tradeTier.update({
    where: { id },
    data: {
      isActive: false,
      updatedBy: session.user?.email || undefined,
    },
  });

  return res.json(tier);
}
