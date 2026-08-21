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
--
-- An entry whose debits do not equal its credits is not an entry. Production
-- has rejected them since 2026-06-06; the integration database could still
-- create them, because db push does not apply migration SQL.
--
-- This was excluded when the guards file was written: applying it failed 9
-- dailyReconciliation tests whose fixtures built exactly that impossible shape.
-- Those fixtures are fixed (issue #115), so the constraint is live here now.
ALTER TABLE "JournalEntry"
  DROP CONSTRAINT IF EXISTS "JournalEntry_balanced_check";
ALTER TABLE "JournalEntry"
  ADD CONSTRAINT "JournalEntry_balanced_check"
  CHECK ("totalDebits" = "totalCredits");

-- 20260801120000_add_configurable_imports
-- A RECONCILE definition needs a registered runner; the engine cannot
-- reconcile from mapping alone.
ALTER TABLE "ImportDefinition" DROP CONSTRAINT IF EXISTS "ImportDefinition_reconcile_requires_runner";
ALTER TABLE "ImportDefinition"
  ADD CONSTRAINT "ImportDefinition_reconcile_requires_runner" CHECK (
    "importMode" <> 'RECONCILE' OR "runnerKey" IS NOT NULL
  );
