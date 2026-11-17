// /app/src/lib/customers/tradeTierAssignment.ts
//
// Giving a customer a trade tier (GAP-06 part C, DECISIONS 61). A tier prices
// every eligible line of their sales below retail with no manager's PIN
// (lib/sales/discountApproval.ts), so who set it is recorded: each change is an
// audit entry, written in the change's own transaction. Only an active tier can
// be given -- a tier turned off grants nothing, so giving it would say one
// thing and do another. Taking a tier away (null) is always allowed.
//
// The one writer of Customer.tradeTierId: the customer's trade route
// (pages/api/customers/[id]/trade.ts) and the demo seed come through here.

import type { Prisma } from "@prisma/client";
import { auditLog } from "@/lib/audit";

export class TradeTierAssignmentError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
    this.name = "TradeTierAssignmentError";
  }
}

/**
 * Set a customer's tier (`tradeTierId` a tier's id, or null for none). Writes
 * nothing and records nothing when it is already that tier -- even one turned
 * off since, which grants nothing until it is on again. Returns whether it
 * changed.
 */
export async function setCustomerTradeTier(
  tx: Prisma.TransactionClient,
  input: { customerId: number; tradeTierId: unknown; actor: string },
): Promise<boolean> {
  const { customerId, actor } = input;
  const tierId = input.tradeTierId == null || input.tradeTierId === "" ? null : input.tradeTierId;
  if (tierId !== null && !(typeof tierId === "number" && Number.isInteger(tierId))) {
    throw new TradeTierAssignmentError("A trade tier is a tier's id, or none.");
  }

  const customer = await tx.customer.findUnique({
    where: { id: customerId },
    select: {
      firstName: true,
      lastName: true,
      tradeTier: { select: { id: true, name: true, discountPercent: true } },
    },
  });
  if (!customer) throw new TradeTierAssignmentError("Customer not found", 404);
  // Saving the customer's trade details sends their tier as it stands, and a
  // tier turned off since is still theirs until someone changes it.
  const before = customer.tradeTier;
  if ((before?.id ?? null) === tierId) return false;

  const tier =
    tierId === null
      ? null
      : await tx.tradeTier.findUnique({
          where: { id: tierId },
          select: { id: true, name: true, discountPercent: true, isActive: true },
        });
  if (tierId !== null && !tier) throw new TradeTierAssignmentError("Trade tier not found");
  if (tier && !tier.isActive) {
    throw new TradeTierAssignmentError(
      `${tier.name} is turned off: turn it back on in Trade tiers before giving it to a customer.`,
    );
  }

  await tx.customer.update({
    where: { id: customerId },
    data: { tradeTierId: tier?.id ?? null, updatedBy: actor },
  });
  const describe = (t: { name: string; discountPercent: Prisma.Decimal } | null) =>
    t ? `${t.name} (${Number(t.discountPercent)}% off retail)` : "none";
  const who = [customer.firstName, customer.lastName].filter(Boolean).join(" ") || "Customer";
  await auditLog(
    "TRADE_TIER_ASSIGNED",
    actor,
    {
      summary: `${who}: trade tier ${describe(before)} → ${describe(tier)}`,
      target: { type: "customer", id: customerId },
      details: {
        fromTierId: before?.id ?? null,
        toTierId: tier?.id ?? null,
        fromPercent: before ? Number(before.discountPercent) : null,
        toPercent: tier ? Number(tier.discountPercent) : null,
      },
    },
    tx,
  );
  return true;
}
