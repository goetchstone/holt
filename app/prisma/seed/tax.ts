// app/prisma/seed/tax.ts

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Prisma 7 requires a driver adapter -- a bare `new PrismaClient()`
// throws at construction. Mirrors src/lib/prisma.ts and the scripts/*.mjs
// seeds, which were migrated when Prisma 7 landed; these seed files were not.
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. Export it (or load app/.env.local) before running this seed.");
}
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function seedTax() {
  // Tax districts
  const ct = await prisma.taxDistrict.upsert({
    where: { shortName: "CT" },
    update: {},
    create: {
      shortName: "CT",
      state: "CT",
      name: "Connecticut State Sales Tax",
    },
  });

  // Tax exempt reasons (matching the POS's labels)
  for (const name of ["Resale", "Out of State", "Non-Profit"]) {
    await prisma.taxExemptReason.upsert({
      where: { name },
      update: {},
      create: { name },
    });
  }

  // Default tax group
  const standardRetail = await prisma.taxGroup.upsert({
    where: { name: "Standard Retail" },
    update: {},
    create: {
      name: "Standard Retail",
      taxBasis: "NET",
      freightTaxable: false,
      miscTaxable: false,
    },
  });

  // CT tax rule: 6.35% on all retail sales
  await prisma.taxRule.upsert({
    where: {
      districtId_groupId_sortOrder: {
        districtId: ct.id,
        groupId: standardRetail.id,
        sortOrder: 0,
      },
    },
    update: { taxRate: 0.0635 },
    create: {
      districtId: ct.id,
      groupId: standardRetail.id,
      taxRate: 0.0635,
      sortOrder: 0,
    },
  });

  console.log(
    "Tax seed complete: CT district, 3 exempt reasons, Standard Retail group, 6.35% rule",
  );
}

seedTax()
  .catch((e) => {
    console.error("Tax seed failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
