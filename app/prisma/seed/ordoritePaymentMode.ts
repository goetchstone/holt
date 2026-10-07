// /app/prisma/seed/ordoritePaymentMode.ts
//
// Persists the Stage 1 "Ordorite Payment Mode" demonstration
// ImportDefinition -- see src/lib/imports/data/ordoritePaymentMode.ts for
// what it proves and docs/domains/imports-configurable.md for the full
// writeup. Created inactive (isActive: false): targetEntity "payment" has
// no live entry in genericImport.ts's IMPORT_ENTITIES yet and no runner, so
// this row is data proving the value-mapping mechanism, not a definition
// anything can run today. NOT referenced by any runtime import path -- the
// live Ordorite payments runner still calls resolvePaymentMode() unchanged.
//
// Idempotent (upsert by name). Run with:
//   npx ts-node prisma/seed/ordoritePaymentMode.ts

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  ORDORITE_PAYMENT_MODE_FIELD_MAPPING,
  ORDORITE_PAYMENT_MODE_VALUE_MAPPINGS,
} from "../../src/lib/imports/data/ordoritePaymentMode";

// Prisma 7 requires a driver adapter -- a bare `new PrismaClient()`
// throws at construction. Mirrors src/lib/prisma.ts and the scripts/*.mjs
// seeds, which were migrated when Prisma 7 landed; these seed files were not.
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. Export it (or load app/.env.local) before running this seed.");
}
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const DEFINITION_NAME = "Ordorite Payment Mode (Stage 1 demonstration)";
const DEFINITION_DESCRIPTION =
  "Demonstrates the value-mapping mechanism for Ordorite's free-text payment " +
  "modes (Card Connect -> CARD, Credit Note -> STORE_CREDIT, etc). Not wired " +
  "to the live import path -- see docs/domains/imports-configurable.md.";

async function main() {
  const existing = await prisma.importDefinition.findFirst({ where: { name: DEFINITION_NAME } });

  const definition = existing
    ? await prisma.importDefinition.update({
        where: { id: existing.id },
        data: {
          description: DEFINITION_DESCRIPTION,
          targetEntity: "payment",
          importMode: "INSERT_ONLY",
          isActive: false,
        },
      })
    : await prisma.importDefinition.create({
        data: {
          name: DEFINITION_NAME,
          description: DEFINITION_DESCRIPTION,
          targetEntity: "payment",
          importMode: "INSERT_ONLY",
          isActive: false,
        },
      });

  await prisma.importFieldMapping.upsert({
    where: {
      definitionId_targetField: {
        definitionId: definition.id,
        targetField: ORDORITE_PAYMENT_MODE_FIELD_MAPPING.targetField,
      },
    },
    update: { sourceColumn: ORDORITE_PAYMENT_MODE_FIELD_MAPPING.sourceColumn },
    create: {
      definitionId: definition.id,
      sourceColumn: ORDORITE_PAYMENT_MODE_FIELD_MAPPING.sourceColumn,
      targetField: ORDORITE_PAYMENT_MODE_FIELD_MAPPING.targetField,
      required: ORDORITE_PAYMENT_MODE_FIELD_MAPPING.required ?? false,
      sortOrder: ORDORITE_PAYMENT_MODE_FIELD_MAPPING.sortOrder ?? 0,
    },
  });

  for (const vm of ORDORITE_PAYMENT_MODE_VALUE_MAPPINGS) {
    await prisma.importValueMapping.upsert({
      where: {
        definitionId_targetField_sourceValue: {
          definitionId: definition.id,
          targetField: vm.targetField,
          sourceValue: vm.sourceValue,
        },
      },
      update: { targetValue: vm.targetValue },
      create: {
        definitionId: definition.id,
        targetField: vm.targetField,
        sourceValue: vm.sourceValue,
        targetValue: vm.targetValue,
      },
    });
  }

  console.log(`Seeded ImportDefinition #${definition.id}: ${definition.name}`);
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
