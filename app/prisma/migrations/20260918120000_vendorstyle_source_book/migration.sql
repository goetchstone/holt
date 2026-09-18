-- VendorStyle.sourceBook: which import/book created each style, so a Delete & Renew
-- of one book scopes its retirement to that book's styles and never clobbers a
-- companion catalog under the same vendor (Hooker casegoods, Wesley Hall Signature
-- Elements). Before this, wholesale-prices.ts discontinued EVERY style of the vendor
-- before its product loop, unconditionally.
ALTER TABLE "VendorStyle" ADD COLUMN "sourceBook" TEXT;

-- Backfill existing rows. Signature Elements are reliably identified by the "SE-"
-- style-number prefix (the only companion book holt imports today). Everything else
-- defaults to "wholesale", its main book; a companion book re-tags its own styles on
-- its next import.
UPDATE "VendorStyle"
SET "sourceBook" = CASE WHEN "styleNumber" LIKE 'SE-%' THEN 'signature-elements' ELSE 'wholesale' END
WHERE "sourceBook" IS NULL;

CREATE INDEX "VendorStyle_vendorId_sourceBook_idx" ON "VendorStyle"("vendorId", "sourceBook");
