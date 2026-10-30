-- GAP-09: an order charges its delivery zone's fee.
--
-- DeliveryZone.baseFee and perPieceFee were stored and shown, but nothing put
-- them on an order. The fee is a line with no product (lib/delivery/
-- deliveryFee.ts), and these columns say which line it is and how it is taxed,
-- rather than leaving reports to recognise it by its name:
--   SalesOrder.deliveryFeeLineItemId    the order's delivery fee line;
--   AppSettings.deliveryFeeTaxGroupId   the tax group delivery sells under
--                                       (null: the district's rules).
ALTER TABLE "SalesOrder" ADD COLUMN "deliveryFeeLineItemId" INTEGER;
ALTER TABLE "AppSettings" ADD COLUMN "deliveryFeeTaxGroupId" INTEGER;

CREATE UNIQUE INDEX "SalesOrder_deliveryFeeLineItemId_key" ON "SalesOrder"("deliveryFeeLineItemId");

ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_deliveryFeeLineItemId_fkey" FOREIGN KEY ("deliveryFeeLineItemId") REFERENCES "OrderLineItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AppSettings" ADD CONSTRAINT "AppSettings_deliveryFeeTaxGroupId_fkey" FOREIGN KEY ("deliveryFeeTaxGroupId") REFERENCES "TaxGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Where delivery income is booked: mapped by the store under POS Transactions
-- (Admin > Setup > Accounting). A fee is refused while it is unmapped, rather
-- than booked to no account -- the same rule as the restocking fee
-- (20261019120000_returns_money).
INSERT INTO "SystemGLMapping" ("section", "label", "updated")
VALUES ('POS_TRANSACTIONS', 'Delivery Fee', CURRENT_TIMESTAMP)
ON CONFLICT ("section", "label") DO NOTHING;
