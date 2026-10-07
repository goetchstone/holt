-- Phase 0 BLOCKER B6 from the SOR plan (2026-04-28).
--
-- Prevents DELETE on Payment rows in terminal states (COMPLETED, REFUNDED,
-- VOIDED). Refunds are recorded as new INSERT rows with originalPaymentId
-- set; deleting a terminal Payment is destructive audit-trail loss with
-- no legitimate use case.
--
-- UPDATE protection is deliberately deferred (see SOR plan B6 Option C):
--   - paymentService.processRefund() legitimately updates COMPLETED ->
--     REFUNDED when an order is fully refunded.
--   - The Stripe checkout flow has an existing code smell where
--     recordPayment() defaults to COMPLETED, then immediately flips to
--     PENDING -- so a blanket "no UPDATE on COMPLETED" trigger would
--     break checkout.
-- UPDATE restriction will land in a follow-up PR after those two flows
-- are cleaned up.
--
-- PENDING and FAILED payments remain mutable + deletable -- those
-- represent in-flight transactions where corrections are legitimate.
-- The trigger only fires on the terminal three.
--
-- Two existing call sites that this trigger will affect:
--   - pages/api/sales/orders/[id].ts:96 (order delete cascading payment
--     deletion). When deleting an order with COMPLETED payments, the
--     delete will now fail. Correct behavior: an order with real money
--     recorded against it should not be silently deleted; cancel + void
--     the payments first.
--   - pages/api/POS/delete-payments.ts (admin "wipe all" endpoint).
--     Will be blocked when any COMPLETED payment exists. Correct
--     behavior: nuclear-option resets need to either go through a
--     status transition first or be treated as a deliberate override
--     (TBD in a future PR if needed).

CREATE OR REPLACE FUNCTION enforce_payment_delete_immutability()
RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('COMPLETED', 'REFUNDED', 'VOIDED') THEN
    RAISE EXCEPTION
      'Cannot DELETE Payment id=% with status=% -- payments in terminal states are append-only. Refunds must be recorded as new INSERT rows with originalPaymentId set. See SOR plan Phase 0 B6 + docs/domains/accounting.md.',
      OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payment_delete_immutability ON "Payment";
CREATE TRIGGER payment_delete_immutability
BEFORE DELETE ON "Payment"
FOR EACH ROW
EXECUTE FUNCTION enforce_payment_delete_immutability();
