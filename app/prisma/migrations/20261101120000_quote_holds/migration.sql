-- GAP-16 and GAP-21: what a sale commits.
--
--   OrderLineItem.holdUntil        the last day a quote holds this line's floor
--                                  stock for its customer. On a quote only held
--                                  lines commit stock; an order commits every
--                                  line. Null on every line written before this.
--   Product.madeToOrder            the one-off product a configured or custom
--                                  cart line mints. A sale never draws free
--                                  stock for it.
--   AppSettings.quoteHoldMaxDays   the longest a quote may hold stock, in days
--                                  from today. 0 = quotes hold nothing. 3, the
--                                  default, is the strict end.
ALTER TABLE "OrderLineItem" ADD COLUMN "holdUntil" DATE;

ALTER TABLE "Product" ADD COLUMN "madeToOrder" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "AppSettings" ADD COLUMN "quoteHoldMaxDays" INTEGER NOT NULL DEFAULT 3;

-- The settings route refuses anything outside 0-365; this is the floor under it.
ALTER TABLE "AppSettings" ADD CONSTRAINT "AppSettings_quoteHoldMaxDays_range"
  CHECK ("quoteHoldMaxDays" >= 0 AND "quoteHoldMaxDays" <= 365);
