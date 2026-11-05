// /app/src/pages/api/sales/interactions/index.ts
//
// Log a contact or a note against a quote or a client. A next follow-up date, when sent,
// is saved on the client's profile in the same transaction. Who can do this is who works
// the pipeline (sales.lead): a follow-up is pipeline work.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { isCashSaleCustomer } from "@/lib/pipelineClient";
import { parseSalesInteractionBody } from "@/lib/salesInteractionBody";

type Target =
  | { ok: true; storeLocation: string; resolvedCustomerId: number | null }
  | { ok: false; status: number; error: string };

/** Which store and client this is about, or why it can't be logged. The quote's store and
 *  client come first; otherwise the salesperson's store and the client sent. */
async function resolveTarget(
  staff: { defaultStore: string | null; activeStoreLocation: { name: string } | null },
  salesOrderId: number | null,
  customerId: number | null,
  nextFollowUpDate: Date | null | undefined,
): Promise<Target> {
  let storeLocation = staff.activeStoreLocation?.name ?? staff.defaultStore ?? "Unknown";
  let resolvedCustomerId = customerId;

  if (salesOrderId) {
    const order = await prisma.salesOrder.findUnique({
      where: { id: salesOrderId },
      select: { storeLocation: true, customerId: true },
    });
    if (!order) return { ok: false, status: 404, error: "Quote not found" };
    if (order.storeLocation) storeLocation = order.storeLocation;
    resolvedCustomerId = resolvedCustomerId ?? order.customerId;
  }

  const settingDate = nextFollowUpDate !== undefined;
  if (settingDate && resolvedCustomerId === null) {
    return { ok: false, status: 400, error: "A follow-up date needs a client." };
  }
  if (resolvedCustomerId !== null) {
    const customer = await prisma.customer.findUnique({
      where: { id: resolvedCustomerId },
      select: { firstName: true, lastName: true },
    });
    if (!customer) return { ok: false, status: 404, error: "Client not found" };
    if (settingDate && isCashSaleCustomer(customer)) {
      return {
        ok: false,
        status: 400,
        error: "The Cash Sale customer can't have a follow-up date.",
      };
    }
  }
  return { ok: true, storeLocation, resolvedCustomerId };
}

export async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // requirePermission guarantees a session; it does NOT guarantee an email, and this route
  // uses email as the StaffMember lookup key.
  const email = session.user?.email;
  if (!email) return res.status(401).json({ error: "Unauthorized" });

  const parsed = parseSalesInteractionBody(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  const { salesOrderId, customerId, source, notes, nextFollowUpDate } = parsed.value;

  const staff = await prisma.staffMember.findUnique({
    where: { email },
    select: { id: true, defaultStore: true, activeStoreLocation: { select: { name: true } } },
  });

  if (!staff) return res.status(400).json({ error: "No staff record found for this user" });

  const target = await resolveTarget(staff, salesOrderId, customerId, nextFollowUpDate);
  if (!target.ok) return res.status(target.status).json({ error: target.error });
  const { storeLocation, resolvedCustomerId } = target;

  const interaction = await prisma.$transaction(async (tx) => {
    const created = await tx.customerInteraction.create({
      data: {
        staffMemberId: staff.id,
        customerId: resolvedCustomerId,
        salesOrderId,
        storeLocation,
        source,
        notes,
        startedAt: new Date(),
        endedAt: new Date(),
        isActive: false,
        createdBy: email,
      },
      select: { id: true, startedAt: true, source: true, notes: true },
    });
    if (nextFollowUpDate !== undefined && resolvedCustomerId !== null) {
      await tx.clientProfile.upsert({
        where: { customerId: resolvedCustomerId },
        create: {
          customerId: resolvedCustomerId,
          nextFollowUpDate,
          createdBy: email,
          updatedBy: email,
        },
        update: { nextFollowUpDate, updatedBy: email },
      });
    }
    return created;
  });

  return res.status(201).json(interaction);
}

export default requirePermission("sales.lead", handler);
