// /app/src/pages/api/inventory/freeze/index.ts

import { NextApiRequest, NextApiResponse } from "next";
import { Session } from "next-auth";
import { requireAuth, requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma, TX_TIMEOUT } from "@/lib/prisma";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    return requireAuth(handleGet)(req, res);
  }
  if (req.method === "POST") {
    return requireAuthWithRole(["MANAGER", "ADMIN"], handlePost)(req, res);
  }
  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

async function handleGet(_req: NextApiRequest, res: NextApiResponse, _session: Session) {
  const freezes = await prisma.inventoryFreeze.findMany({
    orderBy: { freezeDate: "desc" },
    include: {
      _count: { select: { items: true } },
    },
  });

  return res.json(freezes);
}

async function handlePost(req: NextApiRequest, res: NextApiResponse, session: Session) {
  const { description } = req.body || {};

  const freeze = await prisma.$transaction(async (tx) => {
    // Aggregate current inventory positions by product + store location
    const positions = await tx.inventoryPosition.groupBy({
      by: ["productId", "storeLocationId"],
      _sum: { quantity: true },
      where: { quantity: { gt: 0 } },
    });

    const newFreeze = await tx.inventoryFreeze.create({
      data: {
        freezeDate: new Date(),
        description: description || null,
        createdBy: session.user?.email || undefined,
      },
    });

    if (positions.length > 0) {
      await tx.inventoryFreezeItem.createMany({
        data: positions.map((pos) => ({
          freezeId: newFreeze.id,
          productId: pos.productId,
          storeLocationId: pos.storeLocationId,
          quantity: pos._sum.quantity || 0,
        })),
      });
    }

    const totalUnits = positions.reduce((sum, p) => sum + (p._sum.quantity || 0), 0);

    const updated = await tx.inventoryFreeze.update({
      where: { id: newFreeze.id },
      data: {
        status: "COMPLETED",
        totalItems: positions.length,
        totalUnits,
      },
    });

    return updated;
  }, TX_TIMEOUT.LONG);

  return res.status(201).json(freeze);
}
