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

-- 20261016120000_stock_places_and_journal
-- A position always holds something; a row at zero or below is no stock.
ALTER TABLE "InventoryPosition" DROP CONSTRAINT IF EXISTS "InventoryPosition_quantity_positive";
ALTER TABLE "InventoryPosition" ADD CONSTRAINT "InventoryPosition_quantity_positive" CHECK (quantity > 0);

-- The stock journal: positive quantities, at least one side in the books, and
-- each side a whole place or nothing.
ALTER TABLE "StockMovement" DROP CONSTRAINT IF EXISTS "StockMovement_quantity_positive";
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_quantity_positive" CHECK (quantity > 0);
ALTER TABLE "StockMovement" DROP CONSTRAINT IF EXISTS "StockMovement_has_a_side";
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_has_a_side" CHECK (
  "fromStoreLocationId" IS NOT NULL OR "toStoreLocationId" IS NOT NULL
);
ALTER TABLE "StockMovement" DROP CONSTRAINT IF EXISTS "StockMovement_whole_places";
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_whole_places" CHECK (
  ("fromStoreLocationId" IS NULL) = ("fromStockLocationId" IS NULL)
  AND ("toStoreLocationId" IS NULL) = ("toStockLocationId" IS NULL)
  AND ("fromSalesOrderId" IS NULL OR "fromStoreLocationId" IS NOT NULL)
  AND ("toSalesOrderId" IS NULL OR "toStoreLocationId" IS NOT NULL)
);

-- The journal is never rewritten: a correction is a new movement.
CREATE OR REPLACE FUNCTION enforce_stock_movement_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'StockMovement is append-only (id=%): correct stock with a new movement through lib/inventory/ledger.ts, never by changing history.',
    OLD.id
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS stock_movement_append_only ON "StockMovement";
CREATE TRIGGER stock_movement_append_only
BEFORE UPDATE OR DELETE ON "StockMovement"
FOR EACH ROW
EXECUTE FUNCTION enforce_stock_movement_append_only();

-- 20261017120000_document_stock_flows
-- A transfer never receives less than nothing or more than it shipped.
ALTER TABLE "InventoryTransfer" DROP CONSTRAINT IF EXISTS "InventoryTransfer_received_within_quantity";
ALTER TABLE "InventoryTransfer" ADD CONSTRAINT "InventoryTransfer_received_within_quantity" CHECK (
  "receivedQuantity" >= 0 AND "receivedQuantity" <= quantity
);

-- 20261019120000_returns_money
-- Store credit is never spent past zero.
ALTER TABLE "Customer" DROP CONSTRAINT IF EXISTS "Customer_creditBalance_nonnegative";
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_creditBalance_nonnegative" CHECK ("creditBalance" >= 0);
