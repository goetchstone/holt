# POS — Counter Sales, Tills, Registers, Payments

Counter-sales workflow: register check-in, customer/cart build, payment recording, till open/close, gift cards, refunds.

This runbook covers the **ERP-native** POS path. Imported Ordorite orders flow through `docs/domains/import-pipeline.md` and `docs/domains/sales-orders.md` instead. The two paths share `SalesOrder` + `Payment` + `OrderLineItem` storage but use disjoint UI surfaces.

## Components

| Area                         | UI                                                                                                      | API                                                                                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cart + checkout              | `app/(dashboard)/app/sales/pos/PosView.tsx`                                                             | `pages/api/sales/orders/create-from-cart.ts` (order), then `pages/api/sales/orders/[id]/payments.ts` (tender)                                                                                                   |
| Till open/close              | `app/(dashboard)/app/sales/till/TillView.tsx`, `app/(dashboard)/app/sales/till/[id]/TillDetailView.tsx` | `pages/api/registers/[id]/tills/open.ts`, `pages/api/tills/[id]/close.ts`, `pages/api/tills/[id]/reconcile.ts`, `pages/api/tills/index.ts` (list), `pages/api/tills/[id].ts`, `pages/api/tills/[id]/summary.ts` |
| Register list / select       | (POS page header)                                                                                       | `pages/api/registers/index.ts`, `pages/api/registers/[id].ts`, `pages/api/registers/[id]/unblock.ts`                                                                                                            |
| Gift card sale               | `app/(dashboard)/app/sales/gift-card-sale/GiftCardSaleView.tsx`                                         | `pages/api/gift-cards/activate.ts`                                                                                                                                                                              |
| Returns                      | `app/(dashboard)/app/sales/returns/*`                                                                   | `pages/api/returns/*` (see `docs/domains/returns.md`)                                                                                                                                                           |
| Receipt print (thermal 80mm) | `app/print/receipt/[id]/ReceiptPrintView.tsx`                                                           | `pages/api/print/order/[id].ts`                                                                                                                                                                                 |

Authentication is per-route, not one shared role list:

- **Permission-gated** (`requirePermission`): `sales.write` for `create-from-cart`, `pos.operate` for the register list/detail and gift-card activation, `pos.till.manage` to open a till, `pos.till.adjust` to clear a register block.
- **Role-gated** (`requireAuthWithRole`): till close (`REGISTER`/`MANAGER`/`ADMIN`), till reconcile (`MANAGER`/`ADMIN`), order payments (`MANAGER`/`ADMIN`), Stripe create-checkout (`MANAGER`/`ADMIN`).
- **Session-only** (any signed-in user): `pages/api/tills/index.ts`, `pages/api/tills/[id].ts`, `pages/api/tills/[id]/summary.ts`, `pages/api/print/order/[id].ts` (bare `getServerSession`), plus `pages/api/gift-cards/lookup.ts` and `pages/api/gift-cards/presets/resolve.ts` (`requireAuth`).

REGISTER role exists specifically for counter staff; its POS-relevant permissions are `sales.write`, `sales.return`, `pos.operate`, `pos.till.manage` and `payment.take` — not `pos.till.adjust` (`lib/auth/permissionCatalog.ts`).

## Payment recording — `lib/paymentService.ts`

Source of truth for the ERP-native `Payment` writes — POS tender, refund processing, store-credit usage, gift-card redemption, and the PENDING→COMPLETED processor lifecycle. It is not the only writer: imported Ordorite payments bypass this and go through `runPaymentsImport` (`lib/adapters/ordorite/runners.ts`), and `pages/api/portal/pay.ts`, `pages/api/stripe/send-payment-link.ts` and `lib/billing/invoice*.ts` create `Payment` rows with `prisma.payment.create` directly.

Key invariants enforced by `recordPayment()`:

- One `Payment` row per call. **No split-tender per call** today — each tender slice needs its own `POST /api/sales/orders/[id]/payments`, the only caller of `recordPayment`. Schema supports multiple payments per order.
- Payment status follows the function that wrote the row, not the tender type. `recordPayment()` always writes `COMPLETED`. Processor checkouts go through `recordPendingPayment()`, which writes `PENDING` and posts NO ledger entry; `completePayment()` flips it to `COMPLETED` and posts the ledger entry when the webhook confirms. An unpaid `PENDING` row ends as `FAILED` via `expirePendingPayment()` (webhook expiry event, or the `sweepStalePendingPayments` backstop after 24h), or as `VOIDED` via `voidPendingPayment()` — either a `force` re-checkout replacing it, or the operator escape hatch at `POST /api/sales/orders/[id]/payments/[paymentId]/void` (`payment.void`).
- `Payment.method` enum: `CASH`, `CARD`, `CHECK`, `GIFT_CARD`, `STORE_CREDIT`, `WIRE`, `ACH`, `FINANCE`, `OTHER`. Both `status` and `method` are nullable on the model, for imported rows. The string `paymentType` is denormalized for legacy reports (`lib/paymentMethodDisplay.ts`).
- **Customer-ledger atomic update** (Phase 0.5): every `recordPayment` runs inside a `$transaction` that ALSO appends a `CustomerLedgerEntry` and bumps `Customer.openArBalance`. The append is skipped only when there is no customer to ledger against (a walk-in on an unlinked order). Never skip the transaction wrap — drift detection (`lib/customerArDrift.ts`) will fire if the ledger and balance diverge.
- **Refund flow**: `processRefund()` writes a NEW `Payment` row with `isRefund=true` and `originalPaymentId` pointing at the original. The original is rewritten only for one status transition: once the refunds fully cover it, `processRefund` sets it `COMPLETED` → `REFUNDED`. The DB trigger from migration `20260428_payment_delete_immutability_trigger` rejects DELETE on `COMPLETED`/`REFUNDED`/`VOIDED` rows; UPDATE protection is deliberately deferred (that migration's header says why).

## Tills + Registers

**Register** = a named POS station (e.g. "Main Showroom Front Desk"). Static catalog.

**Till** = a single open-to-close session at a register. New row per open; never reused. Fields: opening cash counts (denominations), expected cash, closing counts, variance, status.

Lifecycle:

1. **Open** (`POST /api/registers/[id]/tills/open` with denomination counts or a raw `openingCash`) → status `OPEN`, opening cash computed from counts. Refused with `409` if the register is variance-blocked (see below).
2. **During shift** → `expectedCash` recomputed live as non-`VOIDED` Payment rows accumulate against the till — `PENDING` and `FAILED` rows are counted in (`tillId` FK on `Payment`, `lib/paymentService.ts:calculateTillExpected`)
3. **Close** (`POST /api/tills/[id]/close`) → closing denomination counts + counted `actualCash` → variance = actual − expected → status `CLOSED`. This is where variance is actually computed and where the Phase 0.6 thresholds below are enforced.
4. **Reconcile** (`POST /api/tills/[id]/reconcile`, MANAGER/ADMIN only) → approves the already-computed variance → status `RECONCILED`.

**Variance discipline** (Phase 0.6, shipped — `lib/tillVariance.ts:classifyTillVariance`). Thresholds are named constants (`TILL_VARIANCE_NOTE_THRESHOLD` / `_MANAGER_THRESHOLD` / `_ESCALATION_THRESHOLD`), evaluated against `Math.abs(variance)` — an overage is treated exactly like a shortage of the same size:

- **Variance > $5** → mandatory note. `close.ts` rejects the close (`400`) if no note is supplied once `|variance| > $5`.
- **Variance > $20** → manager required. `reconcile.ts` already requires MANAGER/ADMIN (via the shared `requireAuthWithRole` helper) for **every** reconcile regardless of variance size — a superset of this rule, left as-is rather than narrowed.
- **Variance > $100** → escalation: `close.ts` sets `Register.blockedAt` + `Register.blockReason` (the reason text names the till and the amount; `blockedAt` is the timestamp) in the same transaction that closes the till. `POST /api/registers/[id]/tills/open` refuses new opens (`409`) on a blocked register. **Clearing the block**: `POST /api/registers/[id]/unblock`, gated on the `pos.till.adjust` permission (MANAGER/ADMIN among the built-in roles), requires a `resolutionNote`; it nulls `blockedAt` (which is what actually unblocks opens) but appends the resolution to `blockReason` rather than erasing it, so the escalation's history survives the clear. `reconcile.ts` also re-applies the block defensively for any till that reaches `CLOSED` without having gone through `close.ts`'s check.

`Register.blockedAt` / `Register.blockReason` — migration `20260801114847_till_variance_escalation`, additive/nullable, no backfill.

## Cash movements (planned, not yet shipped)

Phase 1 G8 in the master plan adds a `CashMovement` model for intra-day non-sale cash flow (drops to safe, change orders from bank, petty cash, no-sale drawer opens). Until then, till variance can be opaque (real shortage vs untracked legitimate movement).

## Gift cards

- `lib/giftCard.ts` — pure balance math only (`computeRedemption`, `computeReload`, `computeAdjustment`). The issue/redeem/reload/adjust/void flows live in the routes: `pages/api/gift-cards/activate.ts`, `[id]/redeem.ts`, `[id]/reload.ts`, `[id]/adjust.ts`, `[id]/void.ts`.
- `GiftCard` model has `initialAmount` + `currentBalance`. `currentBalance` is a stored column updated in place by whoever moves the balance; `GiftCardTransaction` is the audit trail alongside it (`balanceBefore`/`balanceAfter` per row), not the stream the balance is recomputed from. Barcode is the redemption identifier.
- Activating a card writes the `GiftCard` plus a `GiftCardTransaction` of type `ISSUANCE`, and **no `Payment` row** — `pages/api/gift-cards/activate.ts` never touches `Payment`. Redeeming is the `GIFT_CARD` branch inside `recordPayment()`: a `Payment` with `method=GIFT_CARD` AND a `REDEMPTION` transaction (negative amount), which also decrements `GiftCard.currentBalance`.
- **Ordorite gift-card sales were never imported** until the Phase 0.5.6 backfill — historical liabilities are reconstructed from an Ordorite "card # / amount / date activated" report (one-off).

## Stripe integration

Stripe is no longer the only processor: checkout creation and webhook verification sit behind a provider seam (`lib/payments/`, with `stripeProvider.ts` and `squareProvider.ts`), and the routes resolve a provider rather than calling Stripe directly.

- `lib/stripe.ts` — Stripe client resolution only (secret key DB-first from Settings, `STRIPE_SECRET_KEY` env fallback) plus the `STRIPE_TEST_EMAIL_OVERRIDE` escape hatch. Checkout-session creation and signature verification live in `lib/payments/stripeProvider.ts`.
- `pages/api/stripe/create-checkout.ts` — creates a checkout session for an order's balance on whichever provider is active, returns the redirect URL, and writes the `PENDING` `Payment` row via `recordPendingPayment` (no ledger entry yet).
- `pages/api/stripe/webhook.ts` — Stripe's delivery endpoint. Signature verification is mandatory: with no webhook secret configured the route rejects outright. On a completion event it finds the `PENDING` `Payment` by `processorTxnId`, calls `completePayment` (status + ledger entry in one transaction) and then `onPaymentReceived`. It also handles `checkout.session.expired`, ending the `PENDING` row as `FAILED`.
- **Idempotency**: `processorTxnId` is **not** unique on `Payment` — there is no unique index on it and no INSERT-on-conflict anywhere. Retried deliveries are safe because the webhook's lookup filters on `status: "PENDING"` and `completePayment` returns early on an already-`COMPLETED` row, so the ledger entry is never double-posted. Stripe retries are normal and frequent.
- Customer portal exposes a payment link per-order at `/portal/order?token=…`, which posts to `pages/api/portal/pay.ts` (JWT token auth, no login, rate-limited at 5/min per IP).

## Order creation from cart

`POST /api/sales/orders/create-from-cart` (`pages/api/sales/orders/create-from-cart.ts`):

1. Reject an empty cart — that is the endpoint's only validation; there is no
   product-exists, qty > 0 or price-sanity check here. Line money is computed
   by `lib/pos/cartPricing.ts:priceCart`, the same module the POS screen
   prices with, so the stored numbers can't diverge from what was charged.
2. Compute tax via `src/lib/tax/resolveTaxRate.ts`: customer exemption, then
   the customer's own district override, then the selling store's district
   (`StoreLocation.taxDistrictId`), then `AppSettings.defaultTaxDistrictId` —
   never a hardcoded district. Rate is then banded per line against each
   line's discounted amount (`TaxRule.triggerPrice`/`startPrice`/`stopPrice`),
   not a single flat percentage for the whole order. See that file's header
   for the full order and what it deliberately does not evaluate yet
   (chained rules, tax-included pricing, per-product tax groups).
3. Generate orderno: `SH-YYMMDD-NNN`. The `SH-` literal is hard-coded in the
   handler and carries no store code (will become per-store-configurable per
   master plan G1 / Phase 1)
4. Create `SalesOrder` (at `status: "QUOTE"`) + line items in one transaction.
   Inventory allocation runs inside that same transaction, over PRODUCT lines
   only — CONFIGURED/CUSTOM lines mint a new `Product` here and have no stock
   position by construction.
5. No payment is recorded here. The POS posts the tender separately to
   `POST /api/sales/orders/[id]/payments`, which calls `recordPayment` and then
   `onPaymentReceived` — that is what promotes QUOTE → ORDER and creates the
   draft POs.
6. Return the order id plus the server-priced subtotal / order discount / tax /
   total. The POS then shows its own take-payment panel; it does not navigate to
   the receipt-print page (see the auto-print gap below).

## Receipt print

`app/print/receipt/[id]/ReceiptPrintView.tsx` — 80mm thermal, 203 DPI. The receipt is drawn onto a canvas at 640px wide (80mm at 203 DPI) and printed as a bitmap, not as HTML text. The browser handles the print dialog. Order data comes from `pages/api/print/order/[id].ts`, which is session-checked but NOT rate-limited — the 30/min limiter is on `pages/api/print-label.ts`, a different surface.

No auto-print on order confirmation yet (master plan G3 / Phase 1).

## Verification checklist (before touching POS code)

- [ ] Read `docs/domains/sales-orders.md` for status derivation conventions
- [ ] Confirm any new `recordPayment` caller wraps in `prisma.$transaction` and appends to `CustomerLedgerEntry`
- [ ] Verify auth against the per-route list above — POS routes are a mix of `requirePermission`, `requireAuthWithRole` and session-only; there is no single role list to copy
- [ ] Test the iPad Pro 12.9" view — POS is the most touch-heavy surface in the app
- [ ] If touching till math, verify the `Payment.tillId` FK is set on the recorded payment

## Test coverage

| File                                                                    | Coverage                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/paymentService.ts` (recordPayment, processRefund)                  | Real-DB integration in `__tests__/integration/paymentServiceLedger.integration.test.ts`                                                                                                                                                                         |
| `lib/giftCard.ts` (balance math: redemption, reload, adjustment)        | Unit tests in `__tests__/giftCard.test.ts`                                                                                                                                                                                                                      |
| `lib/customerLedger.ts` (atomic ledger append)                          | Unit + real-DB integration                                                                                                                                                                                                                                      |
| `lib/tillVariance.ts` (classifyTillVariance, threshold boundaries)      | Unit tests in `__tests__/tillVariance.test.ts`                                                                                                                                                                                                                  |
| Till close/reconcile/open/unblock (variance discipline, register block) | Real-DB integration in `__tests__/integration/tillVarianceEnforcement.integration.test.ts`                                                                                                                                                                      |
| PENDING-payment lifecycle (find-active / void / expire / sweep)         | Real-DB integration in `__tests__/integration/pendingPaymentLifecycle.integration.test.ts`                                                                                                                                                                      |
| Stripe webhook route                                                    | No route test — `__tests__/stripeProvider.test.ts` covers only `extractExpiration`, and `__tests__/apiRouteAuthorization.test.ts:47` only allowlists the route as intentionally unauthenticated; signature verification and completion idempotency have no test |

## Known gaps (master plan Phase 1)

- **G1**: per-store sales prefix config — the orderno prefix is currently the hard-coded literal `SH-`, with no store code in it at all
- **G2**: shipped — `lib/inventory/allocation.ts` commits free stock at order creation (`allocate`, inside `create-from-cart`'s transaction), deletes it at `FULFILLED` (`consume`) and returns it at `CANCELLED` (`release`). Overselling is deliberately still allowed: `allocate` records a shortfall and never blocks the sale.
- **G3**: receipt auto-print on order confirmation
- **G8**: `CashMovement` model + UI for intra-day non-sale cash flow
- **Split tender UI**: schema supports multiple Payments per order; the POS tenders the whole order total in a single call
- **C8**: Stripe webhook idempotency tripwire — there is no `processorTxnId` unique index, so idempotency rests entirely on the `status: "PENDING"` lookup filter plus `completePayment`'s early return. Still untested.

---

Last verified: 2026-08-01
