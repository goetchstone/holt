-- GAP-06 parts B and C: a line records whether the list price it was written at
-- was a scheduled sale price, so the list and its sale flag travel together. A
-- later price edit or a quote changing hands asks whether a trade tier may come
-- off the line's list from this, never from whether the product is on sale today
-- (DECISIONS 61).

-- AlterTable
ALTER TABLE "OrderLineItem" ADD COLUMN     "listOnSale" BOOLEAN NOT NULL DEFAULT false;

-- Lines written before the flag: fail closed. A line whose recorded list is
-- below its product's regular price, or equals a price one of the product's
-- sales set, is read as listed on sale -- so a tier off it stays a discount
-- unless the store lets a tier come off sale prices.
UPDATE "OrderLineItem" AS li
SET "listOnSale" = true
FROM "Product" AS p
WHERE li."productId" = p."id"
  AND li."listPrice" IS NOT NULL
  AND (
    (p."baseRetail" IS NOT NULL AND li."listPrice" < p."baseRetail")
    OR EXISTS (
      SELECT 1 FROM "SaleItem" AS si
      WHERE si."productId" = li."productId" AND si."salePrice" = li."listPrice"
    )
  );
