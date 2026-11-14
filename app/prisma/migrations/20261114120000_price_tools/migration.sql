-- GAP-06: one writer for a product's retail. A category can carry its own markup, a
-- product's price can be locked against automatic changes, and every change to a
-- product's retail or was price is a row in its price ledger.

-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "defaultMarkup" DECIMAL(8,4);

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "priceLocked" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ProductPriceChange" (
    "id" SERIAL NOT NULL,
    "productId" INTEGER NOT NULL,
    "fromRetail" DECIMAL(12,2),
    "toRetail" DECIMAL(12,2),
    "fromWas" DECIMAL(10,2),
    "toWas" DECIMAL(10,2),
    "source" TEXT NOT NULL,
    "batchId" TEXT,
    "note" TEXT,
    "actor" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductPriceChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductPriceChange_productId_createdAt_idx" ON "ProductPriceChange"("productId", "createdAt");

-- CreateIndex
CREATE INDEX "ProductPriceChange_batchId_idx" ON "ProductPriceChange"("batchId");

-- AddForeignKey
ALTER TABLE "ProductPriceChange" ADD CONSTRAINT "ProductPriceChange_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A markup is a multiplier above zero; NULL follows the vendor's or the store's.
ALTER TABLE "Category" ADD CONSTRAINT "Category_defaultMarkup_positive" CHECK (
  "defaultMarkup" IS NULL OR "defaultMarkup" > 0
);

-- The price ledger is never rewritten: a correction is another change.
CREATE OR REPLACE FUNCTION enforce_product_price_change_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'ProductPriceChange is append-only (id=%): change a price again through lib/pricing/retailWriter.ts, never by changing history.',
    OLD.id
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_price_change_append_only ON "ProductPriceChange";
CREATE TRIGGER product_price_change_append_only
BEFORE UPDATE OR DELETE ON "ProductPriceChange"
FOR EACH ROW
EXECUTE FUNCTION enforce_product_price_change_append_only();
