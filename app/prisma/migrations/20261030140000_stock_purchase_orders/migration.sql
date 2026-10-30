-- GAP-01: stock purchase orders written by hand, printed and emailed.
--
--   PurchaseOrder.shipToLocationId  where the vendor delivers: printed as Ship
--                                   To, and the store the Receive screen starts
--                                   on. Null on the POs written before this.
--   EmailQueueAttachment            a file sent with a queued email (the PO's
--                                   PDF), kept so a retry sends the same bytes.
ALTER TABLE "PurchaseOrder" ADD COLUMN "shipToLocationId" INTEGER;

ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_shipToLocationId_fkey" FOREIGN KEY ("shipToLocationId") REFERENCES "StoreLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "EmailQueueAttachment" (
    "id" SERIAL NOT NULL,
    "emailId" INTEGER NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "content" BYTEA NOT NULL,

    CONSTRAINT "EmailQueueAttachment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EmailQueueAttachment_emailId_idx" ON "EmailQueueAttachment"("emailId");

ALTER TABLE "EmailQueueAttachment" ADD CONSTRAINT "EmailQueueAttachment_emailId_fkey" FOREIGN KEY ("emailId") REFERENCES "EmailQueue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
