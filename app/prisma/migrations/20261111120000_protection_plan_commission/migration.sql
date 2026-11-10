-- GAP-24, DECISIONS 56: a commission plan of its own for protection plans.
-- A PROTECTION_PLAN plan prices only the items in its rule's category, ahead of the
-- salesperson's main plan, and each salesperson can be put on one.

CREATE TYPE "CommissionPlanKind" AS ENUM ('MAIN', 'PROTECTION_PLAN');

ALTER TABLE "CommissionPlan"
  ADD COLUMN "kind" "CommissionPlanKind" NOT NULL DEFAULT 'MAIN',
  ADD COLUMN "alsoCountsInMainPlan" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "StaffMember" ADD COLUMN "protectionCommissionPlanId" INTEGER;

ALTER TABLE "StaffMember" ADD CONSTRAINT "StaffMember_protectionCommissionPlanId_fkey"
  FOREIGN KEY ("protectionCommissionPlanId") REFERENCES "CommissionPlan"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CommissionPayout" ADD COLUMN "protectionPlanName" TEXT;
