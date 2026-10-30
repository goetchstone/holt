-- GAP-06: a discount follows the store's policy, and the sale keeps its list
-- price so the saving can be shown.
--
--   OrderLineItem.listPrice           the unit price the line was listed at;
--                                     null on lines written before this.
--   StaffMember.pinHash (+ counters)  the register PIN a manager approves with.
--   AppSettings.discountLimitPercent  what staff without "Apply discounts" may
--                                     give alone. 0, the default, is locked
--                                     down: every such discount needs a manager.
ALTER TABLE "OrderLineItem" ADD COLUMN "listPrice" DECIMAL(65,30);

ALTER TABLE "StaffMember" ADD COLUMN "pinFailedAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "pinHash" TEXT,
ADD COLUMN "pinLockedUntil" TIMESTAMP(3);

ALTER TABLE "AppSettings" ADD COLUMN "discountLimitPercent" INTEGER NOT NULL DEFAULT 0;

-- The settings route refuses anything outside 0-100; this is the floor under it.
ALTER TABLE "AppSettings" ADD CONSTRAINT "AppSettings_discountLimitPercent_range"
  CHECK ("discountLimitPercent" >= 0 AND "discountLimitPercent" <= 100);
