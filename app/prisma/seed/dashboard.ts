// /app/prisma/seed/dashboard.ts
//
// Seeds the 12-month allocation percentages for one year.
// Run with:  npx ts-node prisma/seed/dashboard.ts

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Prisma 7 requires a driver adapter -- a bare `new PrismaClient()`
// throws at construction. Mirrors src/lib/prisma.ts and the scripts/*.mjs
// seeds, which were migrated when Prisma 7 landed; these seed files were not.
if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. Export it (or load app/.env.local) before running this seed.",
  );
}
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

// ⚑  Seeds the current year; change this if you're seeding a different one
const year = new Date().getFullYear();

async function main() {
  // A generic 4-4-5 retail calendar: each quarter's third month carries five
  // weeks of the 52, the other two carry four (4/52 = 7.69%, 5/52 = 9.62%).
  const months = [
    { month: "Jan", percentage: 7.69 },
    { month: "Feb", percentage: 7.69 },
    { month: "Mar", percentage: 9.62 },
    { month: "Apr", percentage: 7.69 },
    { month: "May", percentage: 7.69 },
    { month: "Jun", percentage: 9.62 },
    { month: "Jul", percentage: 7.69 },
    { month: "Aug", percentage: 7.69 },
    { month: "Sep", percentage: 9.62 },
    { month: "Oct", percentage: 7.69 },
    { month: "Nov", percentage: 7.69 },
    { month: "Dec", percentage: 9.62 },
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
