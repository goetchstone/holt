-- GAP-18: a tag's cost code, a product's picture on a tag, a sale tag's was price,
-- a law tag's wording, and how someone prints tags while receiving.
-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "lawTagText" TEXT,
ADD COLUMN     "wasPrice" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "LabelTemplate" ADD COLUMN     "photoDots" INTEGER;

-- AlterTable
ALTER TABLE "StaffMember" ADD COLUMN     "tagPrintMode" TEXT;

-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN     "costCipherKey" TEXT;

ALTER TABLE "Product" ADD CONSTRAINT "Product_wasPrice_positive" CHECK (
  "wasPrice" IS NULL OR "wasPrice" > 0
);
ALTER TABLE "LabelTemplate" ADD CONSTRAINT "LabelTemplate_photoDots_range" CHECK (
  "photoDots" IS NULL OR "photoDots" BETWEEN 1 AND 2000
);
ALTER TABLE "StaffMember" ADD CONSTRAINT "StaffMember_tagPrintMode_known" CHECK (
  "tagPrintMode" IS NULL OR "tagPrintMode" IN ('ONE_AT_A_TIME', 'BATCH')
);
ALTER TABLE "AppSettings" ADD CONSTRAINT "AppSettings_costCipherKey_letters" CHECK (
  "costCipherKey" IS NULL OR "costCipherKey" ~ '^[A-Z]{10}$'
);
