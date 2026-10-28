-- Card payments started from the customer portal (portal/pay.ts) or an
-- emailed payment link (stripe/send-payment-link.ts) were labelled "Deposit"
-- whenever they were for less than the balance. The label is what the sales
-- journal maps to a GL account (POS_PAYMENTS), so that card money posted to
-- the deposit OFFSET account instead of the card account, and the daily
-- reconciliation left it out of tender. Both routes now write through
-- recordPendingPayment, which labels by method.
--
-- Rule 13: the values come from columns the bug did not touch. The same two
-- writers set method = 'CARD' and processorType together with the label; no
-- importer sets processorType, so an imported "Deposit" row is left alone.
-- Re-running this changes nothing.
UPDATE "Payment"
SET "paymentType" = 'Card'
WHERE "paymentType" = 'Deposit'
  AND "method" = 'CARD'
  AND "processorType" IS NOT NULL;
