-- Adds the FK chain resolveTaxRate.ts needs to stop hardcoding `shortName:
-- "CT"` when pricing a sale (create-from-cart.ts / import-hd-proposal.ts).
-- Previously there was no path from a store to its tax jurisdiction at all,
-- so the resolver had nothing to fall back on besides a literal -- a
-- deployment outside Connecticut charged zero sales tax.
--
-- Both columns are nullable and additive. No backfill here: prisma/seed/
-- demo/locations.ts and prisma/seed/demo/accounting.ts set them for the
-- demo dataset; a real deployment's `config/local/*` or an admin sets them
-- for its own stores. Left null, resolveTaxRate.ts falls through to the
-- next tier (AppSettings.defaultTaxDistrictId, then zero tax + a logged
-- warning naming the store) rather than failing the sale.

-- AlterTable
ALTER TABLE "StoreLocation" ADD COLUMN     "taxDistrictId" INTEGER;

-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN     "defaultTaxDistrictId" INTEGER;

-- AddForeignKey
ALTER TABLE "StoreLocation" ADD CONSTRAINT "StoreLocation_taxDistrictId_fkey" FOREIGN KEY ("taxDistrictId") REFERENCES "TaxDistrict"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppSettings" ADD CONSTRAINT "AppSettings_defaultTaxDistrictId_fkey" FOREIGN KEY ("defaultTaxDistrictId") REFERENCES "TaxDistrict"("id") ON DELETE SET NULL ON UPDATE CASCADE;
