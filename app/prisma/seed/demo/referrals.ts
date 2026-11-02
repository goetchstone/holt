// /app/prisma/seed/demo/referrals.ts
//
// Referral sources and who sent whom (GAP-08): a handful of the store's own
// sources, made through lib/customers/referrals.ts as Settings makes them, one
// switched off with customers still on it, and a share of customers tagged
// with a source or a referring customer. Assigned by position, not the RNG, so
// adding this shifted nothing else the seed draws.

import type { PrismaClient } from "@prisma/client";
import { createReferralSource, updateReferralSource } from "@/lib/customers/referrals";
import type { SeededCustomer } from "./customers";

const SEED_ACTOR = "seed:demo";

const SOURCES = [
  "A friend or family member",
  "Walked by the showroom",
  "Instagram",
  "An interior designer",
  "Search",
  "Spring catalog", // switched off below: last year's mailing, kept on its customers
] as const;

export async function seedReferrals(
  prisma: PrismaClient,
  customers: SeededCustomer[],
): Promise<{ sources: number; withSource: number; referred: number }> {
  const ids: number[] = [];
  for (const [sortOrder, name] of SOURCES.entries()) {
    const source = await prisma.$transaction((tx) =>
      createReferralSource(tx, { name, sortOrder }, SEED_ACTOR),
    );
    ids.push(source.id);
  }

  let withSource = 0;
  let referred = 0;
  for (const [i, customer] of customers.entries()) {
    // Two in three customers say how they heard of the store, the sources taken
    // in turn so every one has customers -- the switched-off one too; every
    // fifth customer was sent by the customer two places before them.
    const referralSourceId = i % 3 === 2 ? null : ids[withSource % ids.length];
    const referredByCustomerId = i % 5 === 4 && i >= 2 ? customers[i - 2].id : null;
    if (referralSourceId == null && referredByCustomerId == null) continue;
    await prisma.customer.update({
      where: { id: customer.id },
      data: { referralSourceId, referredByCustomerId },
    });
    if (referralSourceId != null) withSource++;
    if (referredByCustomerId != null) referred++;
  }

  // Switched off once customers have it: they keep it, nobody new is offered it.
  await prisma.$transaction((tx) =>
    updateReferralSource(tx, ids[ids.length - 1], { isActive: false }, SEED_ACTOR),
  );
  return { sources: ids.length, withSource, referred };
}
