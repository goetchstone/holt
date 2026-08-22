-- Vendor.isConsignment.
--
-- Consignment routes resolved "the consignment vendor" by NAME: 38 references
-- across 12 files, including six spellings of one vendor in a single import
-- route and an ILIKE in orderLineItemLinker's raw SQL. That worked for exactly
-- one deployment and broke quietly for a second consignor -- or for a rename.
--
-- docs/tenant-literal-sweep.md claimed this column already existed and had
-- retired the literals. It did not, and the claim is why they went unexamined.
ALTER TABLE "Vendor" ADD COLUMN "isConsignment" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "Vendor_isConsignment_idx" ON "Vendor"("isConsignment");

-- Backfill from the names the code used to match, so an existing deployment
-- keeps working across the deploy. This is the LAST place those names appear.
UPDATE "Vendor"
SET "isConsignment" = true
WHERE name ILIKE '%marjan%';

-- A vendor with a number prefix is consigning too: prefixes were introduced for
-- exactly that flow. Cheap, and it catches a deployment that renamed its
-- consignor before this ran.
UPDATE "Vendor" v
SET "isConsignment" = true
WHERE EXISTS (SELECT 1 FROM "VendorNumberPrefix" p WHERE p."vendorId" = v.id)
  AND v."isConsignment" = false;
