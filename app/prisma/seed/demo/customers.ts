// app/prisma/seed/demo/customers.ts
//
// Customers -- realistic-but-fake names, @example.com emails, invented CT
// addresses. A small trade-account slice is tax-exempt (Resale), matching
// the "Resale" TaxExemptReason accounting.ts seeds.

import type { PrismaClient } from "@prisma/client";
import type { Rng } from "./rng";
import { chance, randInt } from "./rng";
import { emailFor, phoneNumber, randomPersonName, randomTown, streetAddress } from "./names";

const SEED_ACTOR = "seed:demo";

export interface SeededCustomer {
  id: number;
  isTradeAccount: boolean;
  taxExempt: boolean;
}

export async function seedCustomers(
  prisma: PrismaClient,
  rng: Rng,
  taxDistrictId: number,
  resaleTaxExemptReasonId: number,
  customerCount: number,
): Promise<SeededCustomer[]> {
  const customers: SeededCustomer[] = [];

  for (let i = 0; i < customerCount; i++) {
    const { firstName, lastName } = randomPersonName(rng);
    const email = emailFor(rng, firstName, lastName);
    const isTradeAccount = chance(rng, 0.06);
    const taxExempt = isTradeAccount && chance(rng, 0.7);

    const customer = await prisma.customer.create({
      data: {
        firstName,
        lastName,
        email,
        phone: phoneNumber(rng),
        defaultTaxDistrictId: taxDistrictId,
        isTradeAccount,
        tradeCompanyName: isTradeAccount ? `${lastName} Design Group` : null,
        taxExempt,
        taxExemptReasonId: taxExempt ? resaleTaxExemptReasonId : null,
        taxExemptNumber: taxExempt ? `CT-EX-${randInt(rng, 100000, 999999)}` : null,
        createdBy: SEED_ACTOR,
      },
    });

    // Most customers get a home address (used for delivery orders); a few
    // walk-ins never give one, which is realistic for counter sales.
    if (chance(rng, 0.85)) {
      const town = randomTown(rng);
      await prisma.customerAddress.create({
        data: {
          customerId: customer.id,
          label: "Home",
          address1: streetAddress(rng),
          city: town.city,
          state: town.state,
          zip: town.zip,
          createdBy: SEED_ACTOR,
        },
      });
    }

    customers.push({ id: customer.id, isTradeAccount, taxExempt });
  }

  return customers;
}
