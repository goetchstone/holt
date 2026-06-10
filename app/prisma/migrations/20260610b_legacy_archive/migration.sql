-- Legacy Archive (feature flag `legacyArchive`): read-only snapshot of a
-- client's previous system's sales history. Isolated by design — no FKs to
-- live tables; the only FK is the internal cascade from lines to orders.
-- Trigram GIN indexes back the fuzzy people-search (name / company / phone /
-- address) at archive scale.

CREATE TABLE "LegacyOrder" (
    "id" SERIAL NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "salesOrderNumber" TEXT,
    "saleDate" TIMESTAMP(3),
    "customerCode" TEXT,
    "customerName" TEXT,
    "companyName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "phone2" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "zip" TEXT,
    "grandTotal" DECIMAL(65,30),
    "taxTotal" DECIMAL(65,30),
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegacyOrder_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LegacyOrderLine" (
    "id" SERIAL NOT NULL,
    "legacyOrderId" INTEGER NOT NULL,
    "lineNumber" INTEGER,
    "sku" TEXT,
    "description" TEXT,
    "lineTotal" DECIMAL(65,30),
    "vendor" TEXT,
    "vendorSku" TEXT,
    "manufacturer" TEXT,
    "misc1" TEXT,
    "misc2" TEXT,
    "misc3" TEXT,
    "misc4" TEXT,
    "misc5" TEXT,

    CONSTRAINT "LegacyOrderLine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LegacyImportLog" (
    "id" SERIAL NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "sourceFile" TEXT,
    "ordersLoaded" INTEGER NOT NULL DEFAULT 0,
    "linesLoaded" INTEGER NOT NULL DEFAULT 0,
    "errors" TEXT[],
    "triggeredBy" TEXT,

    CONSTRAINT "LegacyImportLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LegacyOrder_orderNumber_key" ON "LegacyOrder"("orderNumber");
CREATE INDEX "LegacyOrder_saleDate_idx" ON "LegacyOrder"("saleDate");
CREATE INDEX "LegacyOrder_customerCode_idx" ON "LegacyOrder"("customerCode");
CREATE INDEX "LegacyOrderLine_legacyOrderId_idx" ON "LegacyOrderLine"("legacyOrderId");
CREATE INDEX "LegacyImportLog_startedAt_idx" ON "LegacyImportLog"("startedAt");

ALTER TABLE "LegacyOrderLine" ADD CONSTRAINT "LegacyOrderLine_legacyOrderId_fkey"
  FOREIGN KEY ("legacyOrderId") REFERENCES "LegacyOrder"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Fuzzy-search support: ILIKE-with-trigram on the people fields.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "LegacyOrder_customerName_trgm_idx" ON "LegacyOrder" USING gin ("customerName" gin_trgm_ops);
CREATE INDEX "LegacyOrder_companyName_trgm_idx" ON "LegacyOrder" USING gin ("companyName" gin_trgm_ops);
CREATE INDEX "LegacyOrder_phone_trgm_idx" ON "LegacyOrder" USING gin ("phone" gin_trgm_ops);
CREATE INDEX "LegacyOrder_address_trgm_idx" ON "LegacyOrder" USING gin ("address" gin_trgm_ops);
