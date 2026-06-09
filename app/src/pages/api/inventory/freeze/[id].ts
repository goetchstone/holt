// /app/src/pages/api/inventory/freeze/[id].ts

import { NextApiRequest, NextApiResponse } from "next";
import { Session } from "next-auth";
import { requireAuth, requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    return requireAuth(handleGet)(req, res);
  }
  if (req.method === "DELETE") {
    return requireAuthWithRole(["MANAGER", "ADMIN"], handleDelete)(req, res);
  }
  res.setHeader("Allow", "GET, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

async function handleGet(req: NextApiRequest, res: NextApiResponse, _session: Session) {
  const id = Number(req.query.id);
  if (Number.isNaN(id)) {
    return res.status(400).json({ error: "Invalid freeze ID" });
  }

  const freeze = await prisma.inventoryFreeze.findUnique({
    where: { id },
    include: {
      items: {
        include: {
          product: { select: { id: true, name: true, productNumber: true } },
          storeLocation: { select: { id: true, name: true, code: true } },
        },
        orderBy: [{ storeLocationId: "asc" }, { productId: "asc" }],
      },
    },
  });

  if (!freeze) {
    return res.status(404).json({ error: "Freeze not found" });
  }

  // Group items by store location for the frontend
  const grouped: Record<
    string,
    {
      storeLocation: { id: number; name: string; code: string } | null;
      items: Array<{
        id: number;
        productId: number;
        productName: string;
        productNumber: string;
        quantity: number;
      }>;
    }
  > = {};

  for (const item of freeze.items) {
    const key = item.storeLocation?.code || "UNASSIGNED";
    if (!grouped[key]) {
      grouped[key] = {
        storeLocation: item.storeLocation,
        items: [],
      };
    }
    grouped[key].items.push({
      id: item.id,
      productId: item.productId,
      productName: item.product.name,
      productNumber: item.product.productNumber,
      quantity: item.quantity,
    });
  }

  return res.json({
    id: freeze.id,
    freezeDate: freeze.freezeDate,
    description: freeze.description,
    status: freeze.status,
    totalItems: freeze.totalItems,
    totalUnits: freeze.totalUnits,
    created: freeze.created,
    createdBy: freeze.createdBy,
    groups: grouped,
  });
}

async function handleDelete(req: NextApiRequest, res: NextApiResponse, session: Session) {
  const id = Number(req.query.id);
  if (Number.isNaN(id)) {
    return res.status(400).json({ error: "Invalid freeze ID" });
  }

  const freeze = await prisma.inventoryFreeze.findUnique({ where: { id } });
  if (!freeze) {
    return res.status(404).json({ error: "Freeze not found" });
  }

  await prisma.inventoryFreeze.update({
    where: { id },
    data: { status: "CANCELLED" },
  });

  return res.json({ success: true });
}
