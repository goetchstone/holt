-- Per-salesperson commission plans. Tiers mirror the CommissionTier row shape
-- so marginal math is unchanged; existing tier rows convert into a single
-- default "Standard" plan (idempotent — safe to re-run after a legacy restore
-- lands rows in CommissionTier).

CREATE TABLE IF NOT EXISTS "CommissionPlan" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,
    CONSTRAINT "CommissionPlan_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "CommissionPlan_name_key" ON "CommissionPlan"("name");

CREATE TABLE IF NOT EXISTS "CommissionPlanTier" (
    "id" SERIAL NOT NULL,
    "planId" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "minYtdSales" DECIMAL(65,30) NOT NULL,
    "maxYtdSalesExclusive" DECIMAL(65,30),
    "rate" DECIMAL(65,30) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "CommissionPlanTier_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "CommissionPlanTier_planId_sortOrder_key" ON "CommissionPlanTier"("planId", "sortOrder");
ALTER TABLE "CommissionPlanTier" DROP CONSTRAINT IF EXISTS "CommissionPlanTier_planId_fkey";
ALTER TABLE "CommissionPlanTier" ADD CONSTRAINT "CommissionPlanTier_planId_fkey"
    FOREIGN KEY ("planId") REFERENCES "CommissionPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StaffMember" ADD COLUMN IF NOT EXISTS "commissionPlanId" INTEGER;
ALTER TABLE "StaffMember" DROP CONSTRAINT IF EXISTS "StaffMember_commissionPlanId_fkey";
ALTER TABLE "StaffMember" ADD CONSTRAINT "StaffMember_commissionPlanId_fkey"
    FOREIGN KEY ("commissionPlanId") REFERENCES "CommissionPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CommissionPayout" ADD COLUMN IF NOT EXISTS "commissionPlanId" INTEGER;
ALTER TABLE "CommissionPayout" ADD COLUMN IF NOT EXISTS "commissionPlanName" TEXT;
ALTER TABLE "CommissionPayout" DROP CONSTRAINT IF EXISTS "CommissionPayout_commissionPlanId_fkey";
ALTER TABLE "CommissionPayout" ADD CONSTRAINT "CommissionPayout_commissionPlanId_fkey"
    FOREIGN KEY ("commissionPlanId") REFERENCES "CommissionPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Convert an existing legacy tier set into the default plan, once.
INSERT INTO "CommissionPlan" ("name", "isDefault", "createdBy")
SELECT 'Standard', true, 'migration:20260611_commission_plans'
WHERE EXISTS (SELECT 1 FROM "CommissionTier")
  AND NOT EXISTS (SELECT 1 FROM "CommissionPlan");

INSERT INTO "CommissionPlanTier" ("planId", "label", "minYtdSales", "maxYtdSalesExclusive", "rate", "sortOrder")
SELECT p."id", t."label", t."minYtdSales", t."maxYtdSalesExclusive", t."rate", t."sortOrder"
FROM "CommissionTier" t
CROSS JOIN (SELECT "id" FROM "CommissionPlan" WHERE "isDefault" LIMIT 1) p
WHERE NOT EXISTS (SELECT 1 FROM "CommissionPlanTier");
