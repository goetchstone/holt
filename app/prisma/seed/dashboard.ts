// /app/prisma/seed/dashboard.ts
//
// Seeds the 12-month allocation percentages for one year.
// Run with:  npx ts-node prisma/seed/dashboard.ts

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// ⚑  Change this if you’re seeding a different year
const year = 2025;

async function main() {
  const months = [
    { month: "Jan", percentage: 7.95 },
    { month: "Feb", percentage: 7.95 },
    { month: "Mar", percentage: 7.95 },
    { month: "Apr", percentage: 9.10 },
    { month: "May", percentage: 9.10 },
    { month: "Jun", percentage: 7.95 },
    { month: "Jul", percentage: 7.95 },
    { month: "Aug", percentage: 9.10 },
    { month: "Sep", percentage: 7.95 },
    { month: "Oct", percentage: 7.95 },
    { month: "Nov", percentage: 9.10 },
    { month: "Dec", percentage: 7.95 },
  ];

  for (const row of months) {
    await prisma.monthlySalesPercentage.upsert({
      where: { year_month: { year, month: row.month } }, // compound unique
      update: { percentage: row.percentage },
      create: { year, ...row },
    });
  }
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });