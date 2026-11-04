-- GAP-07: a handover recorded by mistake can be undone.
--
--   OrderHandover                  each handover as recorded: what it changed on
--                                  the order and its lines, and its stop
--   StockMovement.orderHandoverId  the handover a movement's units left with, so
--                                  an undo puts exactly those back
-- Additive: one new table and one nullable column. Handovers before this have
-- no record, and are not undone.

-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN     "orderHandoverId" INTEGER;

-- CreateTable
CREATE TABLE "OrderHandover" (
    "id" SERIAL NOT NULL,
    "salesOrderId" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "deliveryRunId" INTEGER,
    "deliveryStopId" INTEGER,
    "previousDispatchStatus" "DispatchStatus",
    "linesBefore" JSONB NOT NULL,
    "actor" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undoneAt" TIMESTAMP(3),
    "undoneBy" TEXT,
    "undoReason" TEXT,

    CONSTRAINT "OrderHandover_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderHandover_salesOrderId_idx" ON "OrderHandover"("salesOrderId");

-- CreateIndex
CREATE INDEX "StockMovement_orderHandoverId_idx" ON "StockMovement"("orderHandoverId");

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_orderHandoverId_fkey" FOREIGN KEY ("orderHandoverId") REFERENCES "OrderHandover"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderHandover" ADD CONSTRAINT "OrderHandover_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
