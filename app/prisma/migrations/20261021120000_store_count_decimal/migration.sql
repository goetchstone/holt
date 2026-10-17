-- The store-grain count keeps a part roll's fraction.
--
-- PhysicalInventoryCount.quantity and Reconciliation's expected, counted and
-- variance columns were Int, while the balance they are compared with is
-- Decimal(12,3) and the snapshot is a float. A count of 12.5 yards was stored
-- as 12, and two scans of 0.1 and 0.2 as 0 and 0, without an error
-- (storeCountFractional.integration.test.ts). The flow stays as the POS
-- cutover check, so its columns become fractional like the
-- rest of stock.
--
-- Same widening as 20261015120000_fractional_stock_records: integer -> numeric
-- in place, so every existing whole-unit row keeps its value.
ALTER TABLE "PhysicalInventoryCount"
  ALTER COLUMN "quantity" TYPE DECIMAL(12, 3) USING "quantity"::numeric;

ALTER TABLE "Reconciliation"
  ALTER COLUMN "initialExpected" TYPE DECIMAL(12, 3) USING "initialExpected"::numeric,
  ALTER COLUMN "initialCounted" TYPE DECIMAL(12, 3) USING "initialCounted"::numeric,
  ALTER COLUMN "initialVariance" TYPE DECIMAL(12, 3) USING "initialVariance"::numeric,
  ALTER COLUMN "finalCount" TYPE DECIMAL(12, 3) USING "finalCount"::numeric,
  ALTER COLUMN "finalVariance" TYPE DECIMAL(12, 3) USING "finalVariance"::numeric;
