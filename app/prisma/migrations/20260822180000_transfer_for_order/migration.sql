-- Link a stock transfer to the customer order it serves.
--
-- Allocation is store-scoped: an order written at one store cannot draw stock
-- sitting at another. The answer is to move the stock -- but nothing recorded
-- WHY it moved, so "sold at Store A, stock at Store B" was two disconnected
-- acts joined by a free-text note. Nothing could answer "what is this order
-- waiting on" or "which orders does this transfer unblock".
--
-- Nullable: ordinary stock balancing between stores serves no particular order,
-- and that stays the common case.
--
-- ON DELETE SET NULL rather than CASCADE: if an order is deleted the stock has
-- still physically moved, and destroying that record would lose real inventory
-- history.
ALTER TABLE "InventoryTransfer" ADD COLUMN "salesOrderId" INTEGER;

CREATE INDEX "InventoryTransfer_salesOrderId_idx" ON "InventoryTransfer"("salesOrderId");

ALTER TABLE "InventoryTransfer"
  ADD CONSTRAINT "InventoryTransfer_salesOrderId_fkey"
  FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
