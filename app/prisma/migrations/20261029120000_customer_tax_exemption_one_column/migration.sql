-- Customer.taxExempt (boolean) and Customer.taxExemptReasonId answered the same
-- question. The tax resolver (lib/tax/resolveTaxRate.ts) and so every register
-- and quote sale read the reason id; only the B2B proposal conversion read the
-- boolean. No route wrote either, so staff could not exempt anyone. The reason
-- id stays as the one column, set from the customer screen; the boolean goes.
--
-- Fail closed rather than guess (CLAUDE.md rule 63, principle 8). A customer
-- with the boolean set and no reason was exempt to one reader and taxed by the
-- other, and dropping the column throws that answer away for good. Inventing a
-- reason would exempt them everywhere; dropping silently would tax them
-- everywhere. Either is a decision about someone's tax that this migration has
-- no business making, so it stops and names the count. To proceed, give each
-- such customer a real reason (or clear the flag), then deploy again:
--
--   SELECT id, "firstName", "lastName" FROM "Customer"
--   WHERE "taxExempt" = true AND "taxExemptReasonId" IS NULL;
--
-- A reason with the boolean unset loses nothing: the reason is what the
-- resolver already honoured.
DO $$
DECLARE
  unresolved integer;
BEGIN
  SELECT count(*) INTO unresolved
  FROM "Customer"
  WHERE "taxExempt" = true AND "taxExemptReasonId" IS NULL;

  IF unresolved > 0 THEN
    RAISE EXCEPTION
      '% customer(s) have Customer.taxExempt = true but no taxExemptReasonId. Set a reason on each (or clear the flag) before this migration drops the column.',
      unresolved;
  END IF;
END $$;

ALTER TABLE "Customer" DROP COLUMN "taxExempt";
