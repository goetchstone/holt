-- GAP-21: a receipt for a product whose category keeps no stock counts toward
-- its PO line and puts nothing on the books. Every receipt before this put its
-- units into stock, hence the default.
ALTER TABLE "ReceivingRecord" ADD COLUMN     "intoStock" BOOLEAN NOT NULL DEFAULT true;
