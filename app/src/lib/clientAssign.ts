// /app/src/lib/clientAssign.ts
//
// A manager assigns clients no one owns to a salesperson. This only sets the client's
// primary designer. It adds them to that person's book, shows their quotes with no active
// salesperson in that person's pipeline (lib/clientOwnership.ts) and routes their future
// leads there. It never touches an order's salesperson, which feeds commission.

import { prisma } from "@/lib/prisma";
import type { ClientBookOptions } from "@/lib/clientBook";
import { fetchUnassignedClientIds } from "@/lib/clientBookQuery";
import { isQuoteOwned } from "@/lib/clientOwnership";
import { isCashSaleCustomer } from "@/lib/pipelineClient";

export type AssignClientsResult =
  | { ok: true; toStaff: string; clientCount: number; openQuotes: number }
  | { ok: false; status: number; error: string };

export async function assignClients(
  customerIds: number[],
  toStaffId: number,
  actorEmail: string | null,
): Promise<AssignClientsResult> {
  const [target, customers, activeStaff, openQuotes] = await Promise.all([
    prisma.staffMember.findUnique({
      where: { id: toStaffId },
      select: { id: true, displayName: true, isActive: true },
    }),
    prisma.customer.findMany({
      where: { id: { in: customerIds } },
      select: { firstName: true, lastName: true },
    }),
    prisma.staffMember.findMany({
      where: { isActive: true },
      select: { id: true, displayName: true },
    }),
    prisma.salesOrder.findMany({
      where: { customerId: { in: customerIds }, status: "QUOTE", pipelineArchivedAt: null },
      select: { salesPersonId: true, salesperson: true },
    }),
  ]);

  if (!target) return { ok: false, status: 404, error: "Salesperson not found" };
  if (!target.isActive) return { ok: false, status: 400, error: "That salesperson is not active" };
  if (customers.length < customerIds.length) {
    return { ok: false, status: 404, error: "Client not found" };
  }
  if (customers.some(isCashSaleCustomer)) {
    return { ok: false, status: 400, error: "The Cash Sale customer can't be assigned." };
  }

  await prisma.customer.updateMany({
    where: { id: { in: customerIds } },
    data: { primaryDesignerId: target.id, updatedBy: actorEmail },
  });

  return {
    ok: true,
    toStaff: target.displayName,
    clientCount: customerIds.length,
    // Checked without the new owner: these are the quotes they just picked up.
    openQuotes: openQuotes.filter((quote) => !isQuoteOwned(quote, activeStaff)).length,
  };
}

/** Assign everyone matching the list a manager has on screen. The count they saw has to
 *  still be right, so a bulk change never lands on clients they didn't review. */
export async function assignMatchingClients(
  options: ClientBookOptions,
  expectedCount: number,
  toStaffId: number,
  actorEmail: string | null,
  now: Date,
): Promise<AssignClientsResult> {
  const customerIds = await fetchUnassignedClientIds(options, now);
  if (customerIds.length !== expectedCount) {
    return {
      ok: false,
      status: 409,
      error: `This list changed and now has ${customerIds.length} clients. Check it and try again.`,
    };
  }
  return assignClients(customerIds, toStaffId, actorEmail);
}
