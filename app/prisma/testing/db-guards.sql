-- /app/prisma/testing/db-guards.sql
--
-- Database-level guards, re-applied to the INTEGRATION TEST database.
--
-- Why this file exists: jest.integration.setup.ts builds the test schema with
-- `prisma db push`, not `prisma migrate deploy` -- deliberately, for speed, and
-- documented there. But `db push` only applies schema.prisma. Every trigger,
-- function and raw-SQL CHECK lives in migration SQL, so NONE of them existed in
-- the test database. An entire class of protection was untested and untestable,
-- and that was discovered the only way it could be: an integration test
-- asserted a trigger fires and the delete succeeded instead.
--
-- These statements are copied from the migrations that own them and MUST stay
-- in step. __tests__/dbGuardsCoverage.test.ts fails if a migration grows a
-- guard this file does not carry.
--
-- Every statement must be idempotent -- it runs after each schema push.

-- 20260428_payment_delete_immutability_trigger
-- Payments in terminal states are append-only; refunds are new INSERT rows.
CREATE OR REPLACE FUNCTION enforce_payment_delete_immutability()
RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('COMPLETED', 'REFUNDED', 'VOIDED') THEN
    RAISE EXCEPTION
      'Cannot DELETE Payment id=% with status=% -- payments in terminal states are append-only. Refunds must be recorded as new INSERT rows with originalPaymentId set. See SOR plan Phase 0 B6 + docs/domains/accounting.md.',
      OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payment_delete_immutability ON "Payment";
CREATE TRIGGER payment_delete_immutability
BEFORE DELETE ON "Payment"
FOR EACH ROW
EXECUTE FUNCTION enforce_payment_delete_immutability();

-- 20260606_journal_entry_balance_check
-- Constraint JournalEntry_balanced_check -- DELIBERATELY NOT APPLIED YET.
--
-- Applying it fails 9 tests in dailyReconciliation.integration.test.ts, and
-- they fail for a TRUE reason: their fixtures build JournalEntry rows where
-- totalDebits <> totalCredits. Production has been unable to create such a row
-- since 2026-06-06, and generateSalesJournal always balances -- plugging
-- Over/Short when it must. So those tests have been asserting against a state
-- that cannot occur.
--
-- seedPluggedDay is the clearest case: it models the Over/Short plug as an
-- extra credit on an already-balanced entry, so the plug CREATES the imbalance
-- rather than closing one, which is backwards from what the generator does.
--
-- Fixing that is per-fixture judgement on money tests -- each needs the leg
-- production would actually have emitted, and a careless balancing line would
-- silently change what the test asserts. Left out here rather than rushed, with
-- the constraint named so this is a tracked gap and not a quiet omission.
-- __tests__/dbGuardsCoverage.test.ts enforces that this exclusion carries a
-- reason.

-- 20260801120000_add_configurable_imports
-- A RECONCILE definition needs a registered runner; the engine cannot
-- reconcile from mapping alone.
ALTER TABLE "ImportDefinition" DROP CONSTRAINT IF EXISTS "ImportDefinition_reconcile_requires_runner";
ALTER TABLE "ImportDefinition"
  ADD CONSTRAINT "ImportDefinition_reconcile_requires_runner" CHECK (
    "importMode" <> 'RECONCILE' OR "runnerKey" IS NOT NULL
  );
