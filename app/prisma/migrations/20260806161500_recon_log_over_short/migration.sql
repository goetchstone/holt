-- Record the Over/Short plug as its own reconciliation figure.
--
-- The daily sales journal balances itself by posting the difference to an
-- Over/Short account. That plug used to be reported inside journalRevenue
-- (the reconciliation classified any "4-" account as revenue, and the demo
-- chart seeded Over/Short as a REVENUE account), so a day held together by a
-- plug read as a revenue discrepancy. It gets its own column instead.
--
-- Backfills to 0 for existing rows. That is honest rather than lossy: the
-- historical rows genuinely did not record the plug separately, and their
-- journalRevenue is left exactly as it was rather than retroactively rewritten
-- from a value we cannot recover (CLAUDE.md rule 13 -- never derive a
-- restoration from a memo).
ALTER TABLE "DailyReconciliationLog"
  ADD COLUMN "journalOverShort" DECIMAL(65, 30) NOT NULL DEFAULT 0;
