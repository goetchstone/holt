-- A buyer's draft and a B2B proposal keep a part roll's fraction.
--
-- BuyerDraftItem.qty and ProposalLineItem.quantity were Int, while the stock
-- a draft buys and the order line a proposal becomes are Decimal(12,3). A
-- draft typed as 12.5 yards was stored as 1, a real PO imported for 12.5
-- yards was drafted as 12, and a proposal line of 12.5 yards was stored and
-- ordered as 12, without an error
-- (draftAndProposalQtyFractional.integration.test.ts).
--
-- Same widening as 20261015120000_fractional_stock_records: integer -> numeric
-- in place, so every existing whole-unit row keeps its value.
ALTER TABLE "BuyerDraftItem"
  ALTER COLUMN "qty" TYPE DECIMAL(12, 3) USING "qty"::numeric,
  ALTER COLUMN "qty" SET DEFAULT 1;

ALTER TABLE "ProposalLineItem"
  ALTER COLUMN "quantity" TYPE DECIMAL(12, 3) USING "quantity"::numeric,
  ALTER COLUMN "quantity" SET DEFAULT 1;
