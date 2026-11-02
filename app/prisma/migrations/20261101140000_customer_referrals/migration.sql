-- GAP-08: how a customer heard of the store, and who sent them.
--
--   ReferralSource                 the store's own list (Settings > Referral
--                                  sources); none ships, the store adds its own.
--   Customer.referralSourceId      one of them. RESTRICT: a source in use is
--                                  deactivated, not deleted.
--   Customer.referredByCustomerId  the customer who sent them. SET NULL when that
--                                  customer is deleted; never the customer itself.
CREATE TABLE "ReferralSource" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "ReferralSource_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReferralSource_name_key" ON "ReferralSource"("name");

ALTER TABLE "Customer" ADD COLUMN "referralSourceId" INTEGER,
ADD COLUMN "referredByCustomerId" INTEGER;

CREATE INDEX "Customer_referralSourceId_idx" ON "Customer"("referralSourceId");

CREATE INDEX "Customer_referredByCustomerId_idx" ON "Customer"("referredByCustomerId");

ALTER TABLE "Customer" ADD CONSTRAINT "Customer_referralSourceId_fkey" FOREIGN KEY ("referralSourceId") REFERENCES "ReferralSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Customer" ADD CONSTRAINT "Customer_referredByCustomerId_fkey" FOREIGN KEY ("referredByCustomerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Nobody refers themselves. The route refuses it too; this is the floor under it.
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_not_referred_by_self"
  CHECK ("referredByCustomerId" IS NULL OR "referredByCustomerId" <> "id");
