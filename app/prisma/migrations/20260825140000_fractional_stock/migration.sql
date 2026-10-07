-- Stock quantities become fractional, because a roll of fabric or wallpaper is
-- a length rather than a count.
--
-- The selling side has always been Decimal (OrderLineItem.orderedQuantity,
-- fulfilledQty); the stock side was Int. That split is invisible until you
-- receive a part roll, and then every count, transfer and allocation rounds.
--
-- 3dp because fabric is sold to the eighth of a yard (0.125), which is exact at
-- three places. Postgres widens integer -> numeric in place, so no data moves
-- and every existing whole-unit row is unchanged.
ALTER TABLE "InventoryPosition"
  ALTER COLUMN "quantity" TYPE DECIMAL(12, 3) USING "quantity"::numeric,
  ALTER COLUMN "quantity" SET DEFAULT 1;

ALTER TABLE "InventoryTransfer"
  ALTER COLUMN "quantity" TYPE DECIMAL(12, 3) USING "quantity"::numeric;
