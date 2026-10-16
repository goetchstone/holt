-- Returns money (ledger plan PR 2b, lib/returns/).
--
-- A native return books as its own RETURNED SalesOrder the first time money
-- moves: Return.returnOrderId points at it, and Return.restockingFeeLineItemId
-- at the restocking-fee line on it. Refunds are Payment rows carrying
-- returnId, so a return can be paid out in several payments (part to the
-- card, part to store credit) instead of one refundPaymentId that a second
-- refund overwrote.

ALTER TABLE "Payment" ADD COLUMN "returnId" INTEGER;
ALTER TABLE "Return" ADD COLUMN "restockingFeeLineItemId" INTEGER,
ADD COLUMN "returnOrderId" INTEGER;

-- Carry each return's recorded refund onto the refund row before the old
-- column goes (measured on the local databases first: 21 of 21 demo returns
-- carry one; none elsewhere). refundAmount is not carried: it repeated the
-- refund row's own amount.
UPDATE "Payment" p
SET "returnId" = r.id
FROM "Return" r
WHERE r."refundPaymentId" = p.id;

ALTER TABLE "Return" DROP CONSTRAINT "Return_refundPaymentId_fkey";
ALTER TABLE "Return" DROP COLUMN "refundAmount",
DROP COLUMN "refundPaymentId";

CREATE INDEX "Payment_returnId_idx" ON "Payment"("returnId");
CREATE UNIQUE INDEX "Return_returnOrderId_key" ON "Return"("returnOrderId");
CREATE UNIQUE INDEX "Return_restockingFeeLineItemId_key" ON "Return"("restockingFeeLineItemId");

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "Return"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Return" ADD CONSTRAINT "Return_returnOrderId_fkey" FOREIGN KEY ("returnOrderId") REFERENCES "SalesOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Return" ADD CONSTRAINT "Return_restockingFeeLineItemId_fkey" FOREIGN KEY ("restockingFeeLineItemId") REFERENCES "OrderLineItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The account a restocking fee is income in. Unmapped until an admin maps it
-- (Admin > Setup > Accounting); a nonzero fee is refused while it is unmapped,
-- rather than booked to no account (lib/returns/bookReturn.ts).
INSERT INTO "SystemGLMapping" ("section", "label", "updated")
VALUES ('POS_TRANSACTIONS', 'Restocking Fee', CURRENT_TIMESTAMP)
ON CONFLICT ("section", "label") DO NOTHING;

-- Store credit is never spent past zero. The writers check before they write
-- (lib/customerCredit.ts); this is the floor under them. Measured first: no
-- customer on the local databases holds a negative balance.
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_creditBalance_nonnegative" CHECK ("creditBalance" >= 0);
