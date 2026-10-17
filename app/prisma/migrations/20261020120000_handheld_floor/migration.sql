-- The handheld floor (ledger plan phases 15-20). Additive only: no existing
-- row changes.
--
--   - StockAction: one row per handheld action key, so a retried scan does
--     its work once (lib/inventory/withAction.ts); StockMovement.actionKey
--     says which action moved what.
--   - Product.boxesPerUnit: how many boxes make one unit. Boxes are evidence,
--     never a quantity (lib/inventory/boxes.ts); BoxNote records an incomplete
--     set or a stray box until it is resolved.
--   - StockCount / StockCountLine: counts by place (lib/inventory/count.ts,
--     DECISIONS #21).
--   - ServiceAppointmentType RETURN_PICKUP and ServiceAppointment.returnId: a
--     return's pickup as a run stop (lib/fulfilment/returnPickup.ts). The enum
--     value is not used in this migration, so adding it inside the
--     migration's transaction is safe.

-- AlterEnum
ALTER TYPE "ServiceAppointmentType" ADD VALUE 'RETURN_PICKUP';

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "boxesPerUnit" INTEGER;

-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN     "actionKey" TEXT;

-- AlterTable
ALTER TABLE "ServiceAppointment" ADD COLUMN     "returnId" INTEGER;

-- CreateTable
CREATE TABLE "BoxNote" (
    "id" SERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "productId" INTEGER NOT NULL,
    "storeLocationId" INTEGER NOT NULL,
    "stockLocationId" INTEGER NOT NULL,
    "boxes" INTEGER[],
    "boxesPerUnit" INTEGER NOT NULL,
    "sourceType" TEXT,
    "sourceId" INTEGER,
    "note" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "clearedAt" TIMESTAMP(3),
    "clearedBy" TEXT,
    "clearReason" TEXT,

    CONSTRAINT "BoxNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockCount" (
    "id" SERIAL NOT NULL,
    "storeLocationId" INTEGER NOT NULL,
    "stockLocationId" INTEGER NOT NULL,
    "scope" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "countedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "countedBy" TEXT,
    "postedAt" TIMESTAMP(3),
    "postedBy" TEXT,
    "note" TEXT,

    CONSTRAINT "StockCount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockCountLine" (
    "id" SERIAL NOT NULL,
    "countId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "counted" DECIMAL(12,3) NOT NULL,
    "boxes" INTEGER[],
    "expected" DECIMAL(12,3),
    "difference" DECIMAL(12,3),

    CONSTRAINT "StockCountLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockAction" (
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "actor" TEXT,
    "result" JSONB,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockAction_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "BoxNote_productId_clearedAt_idx" ON "BoxNote"("productId", "clearedAt");

-- CreateIndex
CREATE INDEX "BoxNote_stockLocationId_clearedAt_idx" ON "BoxNote"("stockLocationId", "clearedAt");

-- CreateIndex
CREATE INDEX "StockCount_status_stockLocationId_idx" ON "StockCount"("status", "stockLocationId");

-- CreateIndex
CREATE INDEX "StockCountLine_productId_idx" ON "StockCountLine"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "StockCountLine_countId_productId_key" ON "StockCountLine"("countId", "productId");

-- CreateIndex
CREATE INDEX "StockMovement_actionKey_idx" ON "StockMovement"("actionKey");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceAppointment_returnId_key" ON "ServiceAppointment"("returnId");

-- AddForeignKey
ALTER TABLE "BoxNote" ADD CONSTRAINT "BoxNote_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoxNote" ADD CONSTRAINT "BoxNote_stockLocationId_fkey" FOREIGN KEY ("stockLocationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_stockLocationId_fkey" FOREIGN KEY ("stockLocationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_countId_fkey" FOREIGN KEY ("countId") REFERENCES "StockCount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceAppointment" ADD CONSTRAINT "ServiceAppointment_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "Return"("id") ON DELETE SET NULL ON UPDATE CASCADE;

