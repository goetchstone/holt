-- GAP-07: a split sale's shares, chosen rather than fixed at 50/50.
--
--   SalesOrder.splitPercent          the share credited to the salesperson; the
--                                    split partner gets the rest. Every split
--                                    order so far was 50/50, the default.
--   AppSettings.defaultSplitPercent  where a new split starts. 50 is even.
-- AlterTable
ALTER TABLE "SalesOrder" ADD COLUMN     "splitPercent" INTEGER NOT NULL DEFAULT 50;

-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN     "defaultSplitPercent" INTEGER NOT NULL DEFAULT 50;

-- A share is a real split: neither side gets all of it. The routes refuse
-- anything outside 1-99; these are the floor under them.
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_splitPercent_range"
  CHECK ("splitPercent" >= 1 AND "splitPercent" <= 99);
ALTER TABLE "AppSettings" ADD CONSTRAINT "AppSettings_defaultSplitPercent_range"
  CHECK ("defaultSplitPercent" >= 1 AND "defaultSplitPercent" <= 99);
