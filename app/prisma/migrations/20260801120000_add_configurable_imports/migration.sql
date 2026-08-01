-- Configurable Imports, Stage 1 (docs/domains/imports-configurable.md).
-- Purely additive: three new tables + three new enums, one nullable FK from
-- ImportDefinition to the existing Vendor table, no changes to any existing
-- column. Generated via:
--   npx prisma migrate diff --from-schema <old schema.prisma> \
--     --to-schema prisma/schema.prisma --script

-- CreateEnum
CREATE TYPE "ImportSourceFormat" AS ENUM ('CSV', 'XLSX');

-- CreateEnum
CREATE TYPE "ImportMode" AS ENUM ('INSERT_ONLY', 'UPSERT', 'RECONCILE');

-- CreateEnum
CREATE TYPE "ImportTransform" AS ENUM ('TRIM', 'UPPERCASE', 'LOWERCASE', 'NUMBER', 'DATE', 'CURRENCY');

-- CreateTable
CREATE TABLE "ImportDefinition" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "targetEntity" TEXT NOT NULL,
    "sourceFormat" "ImportSourceFormat" NOT NULL DEFAULT 'CSV',
    "importMode" "ImportMode" NOT NULL DEFAULT 'INSERT_ONLY',
    "naturalKeyFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "vendorId" INTEGER,
    "runnerKey" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "ImportDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportFieldMapping" (
    "id" SERIAL NOT NULL,
    "definitionId" INTEGER NOT NULL,
    "sourceColumn" TEXT NOT NULL,
    "targetField" TEXT NOT NULL,
    "transform" "ImportTransform",
    "required" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ImportFieldMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportValueMapping" (
    "id" SERIAL NOT NULL,
    "definitionId" INTEGER NOT NULL,
    "targetField" TEXT NOT NULL,
    "sourceValue" TEXT NOT NULL,
    "targetValue" TEXT NOT NULL,

    CONSTRAINT "ImportValueMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImportDefinition_targetEntity_idx" ON "ImportDefinition"("targetEntity");

-- CreateIndex
CREATE INDEX "ImportDefinition_vendorId_idx" ON "ImportDefinition"("vendorId");

-- CreateIndex
CREATE INDEX "ImportFieldMapping_definitionId_idx" ON "ImportFieldMapping"("definitionId");

-- CreateIndex
CREATE UNIQUE INDEX "ImportFieldMapping_definitionId_targetField_key" ON "ImportFieldMapping"("definitionId", "targetField");

-- CreateIndex
CREATE INDEX "ImportValueMapping_definitionId_idx" ON "ImportValueMapping"("definitionId");

-- CreateIndex
CREATE UNIQUE INDEX "ImportValueMapping_definitionId_targetField_sourceValue_key" ON "ImportValueMapping"("definitionId", "targetField", "sourceValue");

-- AddForeignKey
ALTER TABLE "ImportDefinition" ADD CONSTRAINT "ImportDefinition_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportFieldMapping" ADD CONSTRAINT "ImportFieldMapping_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "ImportDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportValueMapping" ADD CONSTRAINT "ImportValueMapping_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "ImportDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Structural backstop for the RECONCILE/runnerKey rule (mirrors the
-- JournalEntry_balanced_check precedent, 20260606_journal_entry_balance_check):
-- the application layer (validateImportDefinition, lib/imports/validation.ts)
-- rejects this shape at write time, but a raw write or a future bug should
-- not be able to bypass it. Not expressed in schema.prisma (Prisma has no
-- @@check annotation in this codebase's Prisma version), same as the
-- JournalEntry precedent.
ALTER TABLE "ImportDefinition"
  ADD CONSTRAINT "ImportDefinition_reconcile_requires_runner" CHECK (
    "importMode" <> 'RECONCILE' OR "runnerKey" IS NOT NULL
  );
