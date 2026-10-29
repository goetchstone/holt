// /app/prisma/seed/demo/tenders.ts
//
// Two payment types of the store's own (Settings -> Payment Types), made
// through lib/payments/tenders.ts like the Settings screen makes them, so each
// gets its POS_PAYMENTS mapping on its kind's account. Runs after
// seedAccounting, which maps the kinds. Draws nothing from the RNG.

import type { PrismaClient } from "@prisma/client";
import { createTender } from "@/lib/payments/tenders";

const SEED_ACTOR = "seed:demo";

const TENDERS = [
  // A finance company pays the store and the customer owes them; its
  // approval number is how the store matches the funding.
  { name: "Store Financing", kind: "FINANCE", referenceRequired: true, onInvoices: true },
  { name: "Zelle", kind: "OTHER", referenceRequired: false, onInvoices: true },
] as const;

export async function seedTenders(prisma: PrismaClient): Promise<{ tenders: number }> {
  for (const [sortOrder, t] of TENDERS.entries()) {
    await prisma.$transaction((tx) => createTender(tx, { ...t, sortOrder }, SEED_ACTOR));
  }
  return { tenders: TENDERS.length };
}
