-- Stage 1 commission RULE engine. Additive only: new enums, two new
-- nullable/defaulted columns, two new tables with FKs that SET NULL (never
-- RESTRICT/CASCADE) on the scope-dimension side so deleting a Department /
-- Category / Vendor / StoreLocation / Type never blocks on a commission
-- rule — it just widens that rule's scope to "matches everything" for that
-- dimension, mirroring how CommissionPayout.commissionPlanId already nulls
-- out rather than blocking a plan delete.
--
-- Generated via:
--   prisma migrate diff --from-schema <pre-edit schema.prisma> \
--     --to-schema prisma/schema.prisma --script
-- then hand-appended with the idempotent data migration below, following
-- the exact pattern 20260611_commission_plans established for converting
-- CommissionTier -> CommissionPlan/CommissionPlanTier.

-- CreateEnum
CREATE TYPE "CommissionRuleBasis" AS ENUM ('REVENUE', 'MARGIN', 'UNITS');

-- CreateEnum
CREATE TYPE "CommissionAccumulator" AS ENUM ('YTD', 'PERIOD', 'PER_TRANSACTION');

-- CreateEnum
CREATE TYPE "CommissionTierMode" AS ENUM ('MARGINAL', 'RETROACTIVE', 'THRESHOLD');

-- CreateEnum
CREATE TYPE "CommissionCountsWhen" AS ENUM ('WRITTEN', 'DELIVERED', 'COLLECTED');

-- AlterTable
ALTER TABLE "CommissionPlan" ADD COLUMN IF NOT EXISTS "countsWhen" "CommissionCountsWhen" NOT NULL DEFAULT 'WRITTEN';

-- AlterTable
ALTER TABLE "CommissionPayout" ADD COLUMN IF NOT EXISTS "ruleEngineVersion" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE IF NOT EXISTS "CommissionPlanRule" (
    "id" SERIAL NOT NULL,
    "planId" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "departmentId" INTEGER,
    "categoryId" INTEGER,
    "vendorId" INTEGER,
    "storeLocationId" INTEGER,
    "productTypeId" INTEGER,
    "basis" "CommissionRuleBasis" NOT NULL DEFAULT 'REVENUE',
    "accumulator" "CommissionAccumulator" NOT NULL DEFAULT 'YTD',
    "tierMode" "CommissionTierMode" NOT NULL DEFAULT 'MARGINAL',
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "CommissionPlanRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CommissionRuleTier" (
    "id" SERIAL NOT NULL,
    "ruleId" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "minAmount" DECIMAL(65,30) NOT NULL,
    "maxAmountExclusive" DECIMAL(65,30),
    "rate" DECIMAL(65,30),
    "perUnitAmount" DECIMAL(65,30),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CommissionRuleTier_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CommissionPlanRule_planId_idx" ON "CommissionPlanRule"("planId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CommissionPlanRule_planId_sortOrder_key" ON "CommissionPlanRule"("planId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CommissionRuleTier_ruleId_sortOrder_key" ON "CommissionRuleTier"("ruleId", "sortOrder");

-- AddForeignKey
ALTER TABLE "CommissionPlanRule" DROP CONSTRAINT IF EXISTS "CommissionPlanRule_planId_fkey";
ALTER TABLE "CommissionPlanRule" ADD CONSTRAINT "CommissionPlanRule_planId_fkey"
    FOREIGN KEY ("planId") REFERENCES "CommissionPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionPlanRule" DROP CONSTRAINT IF EXISTS "CommissionPlanRule_departmentId_fkey";
ALTER TABLE "CommissionPlanRule" ADD CONSTRAINT "CommissionPlanRule_departmentId_fkey"
    FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionPlanRule" DROP CONSTRAINT IF EXISTS "CommissionPlanRule_categoryId_fkey";
ALTER TABLE "CommissionPlanRule" ADD CONSTRAINT "CommissionPlanRule_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionPlanRule" DROP CONSTRAINT IF EXISTS "CommissionPlanRule_vendorId_fkey";
ALTER TABLE "CommissionPlanRule" ADD CONSTRAINT "CommissionPlanRule_vendorId_fkey"
    FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionPlanRule" DROP CONSTRAINT IF EXISTS "CommissionPlanRule_storeLocationId_fkey";
ALTER TABLE "CommissionPlanRule" ADD CONSTRAINT "CommissionPlanRule_storeLocationId_fkey"
    FOREIGN KEY ("storeLocationId") REFERENCES "StoreLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionPlanRule" DROP CONSTRAINT IF EXISTS "CommissionPlanRule_productTypeId_fkey";
ALTER TABLE "CommissionPlanRule" ADD CONSTRAINT "CommissionPlanRule_productTypeId_fkey"
    FOREIGN KEY ("productTypeId") REFERENCES "Type"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionRuleTier" DROP CONSTRAINT IF EXISTS "CommissionRuleTier_ruleId_fkey";
ALTER TABLE "CommissionRuleTier" ADD CONSTRAINT "CommissionRuleTier_ruleId_fkey"
    FOREIGN KEY ("ruleId") REFERENCES "CommissionPlanRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- DATA MIGRATION — convert every existing CommissionPlanTier set into an
-- equivalent single CommissionPlanRule (scope = all i.e. every scope FK
-- NULL, basis = REVENUE, accumulator = YTD, tierMode = MARGINAL) +
-- CommissionRuleTier rows, so the rule engine (which reads ONLY rules)
-- produces BYTE-IDENTICAL payouts for every plan that existed before this
-- migration. Idempotent — safe to re-run (mirrors 20260611_commission_plans'
-- convention): a plan that already has ANY CommissionPlanRule row is
-- skipped entirely.
--
-- The label MUST equal lib/commissionRuleEngine.ts's
-- LEGACY_MIRROR_RULE_LABEL constant exactly — lib/commissionPlans.ts's
-- replacePlanTiers/createPlan look up an existing rule by this exact label
-- to keep it in sync on every future tier edit (find-by-label, not
-- find-by-id, precisely so the FIRST post-migration edit updates this
-- migration-created row in place rather than creating a duplicate).
-- ---------------------------------------------------------------------------

INSERT INTO "CommissionPlanRule"
  ("planId", "label", "sortOrder", "isActive", "basis", "accumulator", "tierMode", "createdBy")
SELECT p."id",
       'All sales (YTD, marginal) — auto-synced from tiers',
       0,
       true,
       'REVENUE',
       'YTD',
       'MARGINAL',
       'migration:20260801_commission_rule_engine'
FROM "CommissionPlan" p
WHERE EXISTS (SELECT 1 FROM "CommissionPlanTier" t WHERE t."planId" = p."id")
  AND NOT EXISTS (SELECT 1 FROM "CommissionPlanRule" r WHERE r."planId" = p."id");

INSERT INTO "CommissionRuleTier" ("ruleId", "label", "minAmount", "maxAmountExclusive", "rate", "sortOrder")
SELECT r."id", t."label", t."minYtdSales", t."maxYtdSalesExclusive", t."rate", t."sortOrder"
FROM "CommissionPlanTier" t
JOIN "CommissionPlanRule" r
  ON r."planId" = t."planId"
 AND r."label" = 'All sales (YTD, marginal) — auto-synced from tiers'
WHERE NOT EXISTS (SELECT 1 FROM "CommissionRuleTier" rt WHERE rt."ruleId" = r."id");
