-- GAP-22: an item can be bought from more than one vendor (owner, 2026-11-01:
-- "an item could have multiple vendors ... a po is always linked to a single
-- source"; docs/DECISIONS.md 31).
--
--   ProductSource   another vendor an item can be bought from, with that
--                   vendor's number for it and its cost. The item's own vendor
--                   (Product.vendorId) is unchanged and still the one for
--                   pricing and reports. No rows exist before this.

-- CreateTable
CREATE TABLE "ProductSource" (
    "id" SERIAL NOT NULL,
    "productId" INTEGER NOT NULL,
    "vendorId" INTEGER NOT NULL,
    "itemNumber" TEXT,
    "cost" DECIMAL(65,30),
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "ProductSource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductSource_vendorId_idx" ON "ProductSource"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductSource_productId_vendorId_key" ON "ProductSource"("productId", "vendorId");

-- AddForeignKey
ALTER TABLE "ProductSource" ADD CONSTRAINT "ProductSource_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductSource" ADD CONSTRAINT "ProductSource_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- The route refuses anything else; these are the floor under it.
ALTER TABLE "ProductSource" ADD CONSTRAINT "ProductSource_cost_nonnegative"
  CHECK ("cost" IS NULL OR "cost" >= 0);
ALTER TABLE "ProductSource" ADD CONSTRAINT "ProductSource_itemNumber_not_blank"
  CHECK ("itemNumber" IS NULL OR btrim("itemNumber") <> '');
