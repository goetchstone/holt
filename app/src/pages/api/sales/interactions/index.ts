// /app/src/pages/api/sales/interactions/index.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]";
import { prisma } from "@/lib/prisma";

interface CreateInteractionBody {
  salesOrderId?: number;
  customerId?: number;
  source: "WALK_IN" | "PHONE" | "EMAIL" | "APPOINTMENT" | "MANAGER_NOTE";
  notes?: string;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.email) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { salesOrderId, customerId, source, notes } = req.body as CreateInteractionBody;

  if (!source) return res.status(400).json({ error: "source is required" });

  const staff = await prisma.staffMember.findUnique({
    where: { email: session.user.email },
    select: { id: true, defaultStore: true, activeStoreLocation: { select: { name: true } } },
  });

  if (!staff) return res.status(400).json({ error: "No staff record found for this user" });

  // Determine storeLocation: prefer the order's store, then staff's active/default store
  let storeLocation = staff.activeStoreLocation?.name ?? staff.defaultStore ?? "Unknown";
  let resolvedCustomerId = customerId;

  if (salesOrderId) {
    const order = await prisma.salesOrder.findUnique({
      where: { id: salesOrderId },
      select: { storeLocation: true, customerId: true },
    });
    if (order?.storeLocation) storeLocation = order.storeLocation;
    if (!resolvedCustomerId && order?.customerId) resolvedCustomerId = order.customerId;
  }

  const interaction = await prisma.customerInteraction.create({
    data: {
      staffMemberId: staff.id,
      customerId: resolvedCustomerId ?? null,
      salesOrderId: salesOrderId ?? null,
      storeLocation,
      source,
      notes: notes || null,
      startedAt: new Date(),
      endedAt: new Date(),
      isActive: false,
      createdBy: session.user.email,
    },
    select: {
      id: true,
      startedAt: true,
      source: true,
      notes: true,
    },
  });

  return res.status(201).json(interaction);
}
