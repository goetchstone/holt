-- AppSettings.orderNumberPrefix / barcodePrefix: the prefixes a business stamps
-- on its own sales-order numbers and generated barcodes. Both were hardcoded to
-- one pilot's initials ("SH-") before USE-12. Nullable and unset by default: unset
-- resolves to the initials of the business's own name (appSettings.ts). Existing
-- orders keep the numbers they were issued.
ALTER TABLE "AppSettings" ADD COLUMN "orderNumberPrefix" TEXT;
ALTER TABLE "AppSettings" ADD COLUMN "barcodePrefix" TEXT;
