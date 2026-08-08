// /app/src/pages/api/sales/interactions/index.ts

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";

interface CreateInteractionBody {
  salesOrderId?: number;
  customerId?: number;
  source: "WALK_IN" | "PHONE" | "EMAIL" | "APPOINTMENT" | "MANAGER_NOTE";
  notes?: string;
}

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // requireAuthWithRole guarantees a session and a role; it does NOT guarantee
  // an email, and this route uses email as the StaffMember lookup key. The
  // check the wrapper replaced was doing double duty -- authorization AND
  // narrowing `email` to string for the query below.
  const email = session.user?.email;
  if (!email) return res.status(401).json({ error: "Unauthorized" });

  const { salesOrderId, customerId, source, notes } = req.body as CreateInteractionBody;

  if (!source) return res.status(400).json({ error: "source is required" });

  const staff = await prisma.staffMember.findUnique({
    where: { email },
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

export default requirePermission("customer.write", handler);
