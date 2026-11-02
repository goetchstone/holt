-- GAP-22: merging duplicate vendors (lib/vendors/mergeVendor.ts).
--
--   VendorAlias   a name a vendor went by before it was merged into another.
--                 Every lookup of a vendor by name (lib/vendors/vendorByName.ts)
--                 finds the vendor through it, so the next import that spells
--                 the old name doesn't bring the duplicate back. No rows exist
--                 before this.

-- CreateTable
CREATE TABLE "VendorAlias" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "vendorId" INTEGER NOT NULL,
    "mergedVendorId" INTEGER NOT NULL,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "VendorAlias_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VendorAlias_name_key" ON "VendorAlias"("name");

-- CreateIndex
CREATE INDEX "VendorAlias_vendorId_idx" ON "VendorAlias"("vendorId");

-- AddForeignKey
ALTER TABLE "VendorAlias" ADD CONSTRAINT "VendorAlias_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- An alias is a name someone will type or an import will spell; a blank one
-- would match a blank vendor column in a file.
ALTER TABLE "VendorAlias" ADD CONSTRAINT "VendorAlias_name_not_blank" CHECK (btrim("name") <> '');
