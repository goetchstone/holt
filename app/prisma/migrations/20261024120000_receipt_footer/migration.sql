-- The store's own returns or warranty note, printed at the foot of every
-- receipt and invoice.
--
-- The receipt printed "Returns within 7 days with receipt." from a literal in
-- the code, for every deployment: one store's policy, given to all of them.
-- Nullable, and no backfill: a policy nobody has written prints nothing rather
-- than a promise the store never made.
ALTER TABLE "AppSettings" ADD COLUMN "receiptFooter" TEXT;
