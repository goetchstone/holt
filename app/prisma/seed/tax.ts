// app/prisma/seed/tax.ts

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

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
