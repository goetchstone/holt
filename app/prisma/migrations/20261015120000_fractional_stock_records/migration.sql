-- The columns that record stock, rather than hold it, become fractional too.
--
-- 20260825140000_fractional_stock made InventoryPosition and InventoryTransfer
-- Decimal(12,3). Four columns written from those quantities stayed Int: an
-- oversell's requested/allocated/shortfall, a freeze's per-item quantity and
-- total, and a pick list's line. A part roll reaching any of them lost its
-- fraction without an error -- 4.5 yards was recorded as 4, a 37.625-yard
-- freeze as 37 (fractionalStock.integration.test.ts).
--
-- Same widening as before: integer -> numeric happens in place, so every
-- existing whole-unit row keeps its value.
ALTER TABLE "InventoryException"
  ALTER COLUMN "requested" TYPE DECIMAL(12, 3) USING "requested"::numeric,
  ALTER COLUMN "allocated" TYPE DECIMAL(12, 3) USING "allocated"::numeric,
  ALTER COLUMN "shortfall" TYPE DECIMAL(12, 3) USING "shortfall"::numeric;

ALTER TABLE "InventoryFreeze"
  ALTER COLUMN "totalUnits" TYPE DECIMAL(12, 3) USING "totalUnits"::numeric,
  ALTER COLUMN "totalUnits" SET DEFAULT 0;

ALTER TABLE "InventoryFreezeItem"
  ALTER COLUMN "quantity" TYPE DECIMAL(12, 3) USING "quantity"::numeric;

ALTER TABLE "PickListItem"
  ALTER COLUMN "quantity" TYPE DECIMAL(12, 3) USING "quantity"::numeric,
  ALTER COLUMN "quantity" SET DEFAULT 1;
