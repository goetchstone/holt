# POS — Counter Sales, Tills, Registers, Payments

Counter-sales workflow: register check-in, customer/cart build, payment recording, till open/close, gift cards, refunds.

This runbook covers the **ERP-native** POS path. Imported the POS orders flow through `docs/domains/import-pipeline.md` and `docs/domains/sales-orders.md` instead. The two paths share `SalesOrder` + `Payment` + `OrderLineItem` storage but use disjoint UI surfaces.

## Components

| Area | UI | API |
|---|---|---|
| Cart + checkout | `pages/sales/pos.tsx` | `pages/api/sales/orders/create-from-cart.ts` |
| Till open/close | `pages/sales/till.tsx`, `pages/sales/till/[id].tsx` | `pages/api/registers/[id]/tills/open.ts`, `pages/api/tills/[id]/close.ts`, `pages/api/tills/[id]/reconcile.ts`, `pages/api/tills/index.ts` (list) |
| Register list / select | (POS page header) | `pages/api/registers/index.ts`, `pages/api/registers/[id]/*` |
| Gift card sale | `pages/sales/gift-card-sale.tsx` | `pages/api/gift-cards/sell.ts` |
| Returns | `pages/sales/returns/*` | `pages/api/returns/*` (see `docs/domains/returns.md`) |
| Receipt print (thermal 80mm) | `pages/print/receipt/[id].tsx` | `pages/api/print/*` |

Authentication: `roles: ["ADMIN", "MANAGER", "REGISTER"]` on every endpoint. REGISTER role exists specifically for counter staff.

## Payment recording — `lib/paymentService.ts`

Single source of truth for any `Payment` row write — ERP-native POS, refund processing, store-credit usage, gift-card redemption. Imported the POS payments bypass this and go through `runPaymentsImport`.

Key invariants enforced by `recordPayment()`:

- One `Payment` row per call. **No split-tender per call** today — the UI must call `recordPayment` once per tender slice. Schema supports multiple payments per order.
- Payment status defaults to `COMPLETED` for cash/check/manual-card; stays `PENDING` for Stripe until the webhook confirms.
- `Payment.method` enum: `CASH`, `CARD`, `CHECK`, `GIFT_CARD`, `STORE_CREDIT`, `OTHER`. The string `paymentType` is denormalized for legacy reports.
- **Customer-ledger atomic update** (Phase 0.5): every `recordPayment` runs inside a `$transaction` that ALSO appends a `CustomerLedgerEntry` and bumps `Customer.openArBalance`. Never skip the transaction wrap — drift detection (`lib/customerArDrift.ts`) will fire if the ledger and balance diverge.
- **Refund flow**: `processRefund()` writes a NEW `Payment` row with `isRefund=true` and `originalPaymentId` pointing at the original. Never UPDATE the original. The DB trigger from migration `20260427_payment_immutability_trigger` rejects DELETE/UPDATE on `status=COMPLETED` rows.

## Tills + Registers

**Register** = a named POS station (e.g. "Main Showroom Front Desk"). Static catalog.

**Till** = a single open-to-close session at a register. New row per open; never reused. Fields: opening cash counts (denominations), expected cash, closing counts, variance, status.

Lifecycle:

1. **Open** (`POST /api/registers/[id]/tills/open` with denomination counts or a raw `openingCash`) → status `OPEN`, opening cash computed from counts. Refused with `409` if the register is variance-blocked (see below).
2. **During shift** → `expectedCash` recomputed live as Payment rows accumulate against the till (`tillId` FK on `Payment`, `lib/paymentService.ts:calculateTillExpected`)
3. **Close** (`POST /api/tills/[id]/close`) → closing denomination counts + counted `actualCash` → variance = actual − expected → status `CLOSED`. This is where variance is actually computed and where the Phase 0.6 thresholds below are enforced.
4. **Reconcile** (`POST /api/tills/[id]/reconcile`, MANAGER/ADMIN only) → approves the already-computed variance → status `RECONCILED`.

**Variance discipline** (Phase 0.6, shipped — `lib/tillVariance.ts:classifyTillVariance`). Thresholds are named constants (`TILL_VARIANCE_NOTE_THRESHOLD` / `_MANAGER_THRESHOLD` / `_ESCALATION_THRESHOLD`), evaluated against `Math.abs(variance)` — an overage is treated exactly like a shortage of the same size:

- **Variance > $5** → mandatory note. `close.ts` rejects the close (`400`) if no note is supplied once `|variance| > $5`.
- **Variance > $20** → manager required. `reconcile.ts` already requires MANAGER/ADMIN (via the shared `requireAuthWithRole` helper) for **every** reconcile regardless of variance size — a superset of this rule, left as-is rather than narrowed.
- **Variance > $100** → escalation: `close.ts` sets `Register.blockedAt` + `Register.blockReason` (naming the till, amount, and timestamp) in the same transaction that closes the till. `POST /api/registers/[id]/tills/open` refuses new opens (`409`) on a blocked register. **Clearing the block**: `POST /api/registers/[id]/unblock`, MANAGER/ADMIN only, requires a `resolutionNote`; it nulls `blockedAt` (which is what actually unblocks opens) but appends the resolution to `blockReason` rather than erasing it, so the escalation's history survives the clear. `reconcile.ts` also re-applies the block defensively for any till that reaches `CLOSED` without having gone through `close.ts`'s check.

`Register.blockedAt` / `Register.blockReason` — migration `20260801114847_till_variance_escalation`, additive/nullable, no backfill.

## Cash movements (planned, not yet shipped)

Phase 1 G8 in the master plan adds a `CashMovement` model for intra-day non-sale cash flow (drops to safe, change orders from bank, petty cash, no-sale drawer opens). Until then, till variance can be opaque (real shortage vs untracked legitimate movement).

## Gift cards

- `lib/giftCard.ts` — issue, redeem, void
- `GiftCard` model has `initialAmount` + `currentBalance` (computed from a transaction stream). Barcode is the redemption identifier.
- Selling a gift card creates a `Payment` with `method=GIFT_CARD` AND a `GiftCardTransaction` of type `ISSUED`. Redeeming creates a `Payment` with `method=GIFT_CARD` AND a `REDEMPTION` transaction (negative amount on the GC balance).
- **the POS gift-card sales were never imported** until the Phase 0.5.6 backfill — historical liabilities are reconstructed from an the POS "card # / amount / date activated" report (one-off).

## Stripe integration

- `lib/stripe.ts` — checkout session creation, signature verification
- `pages/api/stripe/create-checkout.ts` — creates a Stripe Checkout session for an order's balance, returns the redirect URL
- `pages/api/stripe/webhook.ts` — signature-verified webhook handler. On `checkout.session.completed`, marks the corresponding `Payment` row `COMPLETED` and atomically appends the ledger entry.
- **Idempotency**: `processorTxnId` is unique on `Payment` (or should be — verify before launch). The webhook handler uses INSERT-with-conflict-do-nothing semantics so retried webhook deliveries can't double-record. Stripe retries are normal and frequent.
- Customer portal exposes a Stripe payment link per-order at `/portal/[token]/pay`. Token-based access, no login required.

## Order creation from cart

`POST /api/sales/orders/create-from-cart` (`pages/api/sales/orders/create-from-cart.ts`):

1. Validate cart line items (product exists, qty > 0, price sane)
2. Compute tax via `src/lib/tax/resolveTaxRate.ts`: customer exemption, then
   the customer's own district override, then the selling store's district
   (`StoreLocation.taxDistrictId`), then `AppSettings.defaultTaxDistrictId` —
   never a hardcoded district. Rate is then banded per line against each
   line's discounted amount (`TaxRule.triggerPrice`/`startPrice`/`stopPrice`),
   not a single flat percentage for the whole order. See that file's header
   for the full order and what it deliberately does not evaluate yet
   (chained rules, tax-included pricing, per-product tax groups).
3. Generate orderno: `SH-{storeCode}-YYMMDD-NNN` (will become per-store-configurable per master plan G1 / Phase 1)
4. Create `SalesOrder` + line items in a transaction
5. Optionally call `recordPayment` if a tender slice was provided with the create request
6. Return the order id; UI navigates to the receipt-print page

## Receipt print

`pages/print/receipt/[id].tsx` — 80mm thermal, 203 DPI, rendered to a print-only HTML page. The browser handles the print dialog. Rate-limited at 30/min per `pages/api/print/*`.

No auto-print on order confirmation yet (master plan G3 / Phase 1).

## Verification checklist (before touching POS code)

- [ ] Read `docs/domains/sales-orders.md` for status derivation conventions
- [ ] Confirm any new `recordPayment` caller wraps in `prisma.$transaction` and appends to `CustomerLedgerEntry`
- [ ] Verify auth: `roles: ["ADMIN", "MANAGER", "REGISTER"]` on every endpoint
- [ ] Test the iPad Pro 12.9" view — POS is the most touch-heavy surface in the app
- [ ] If touching till math, verify the `Payment.tillId` FK is set on the recorded payment

## Test coverage

| File | Coverage |
|---|---|
| `lib/paymentService.ts` (recordPayment, processRefund) | Real-DB integration in `__tests__/integration/paymentServiceLedger.integration.test.ts` |
| `lib/giftCard.ts` (issue, redeem) | Unit tests in `__tests__/giftCard.test.ts` |
| `lib/customerLedger.ts` (atomic ledger append) | Unit + real-DB integration |
| `lib/tillVariance.ts` (classifyTillVariance, threshold boundaries) | Unit tests in `__tests__/tillVariance.test.ts` |
| Till close/reconcile/open/unblock (variance discipline, register block) | Real-DB integration in `__tests__/integration/tillVarianceEnforcement.integration.test.ts` |
| Stripe webhook | None — should add tripwire for signature verification + idempotency |

## Known gaps (master plan Phase 1)

- **G1**: per-store sales prefix config — orderno prefix is currently hard-coded by store code
- **G2**: real-time inventory reserve at quote-confirm; deduct at fulfillment
- **G3**: receipt auto-print on order confirmation
- **G8**: `CashMovement` model + UI for intra-day non-sale cash flow
- **Split tender UI**: schema supports multiple Payments per order; UI accepts one at a time
- **C8**: Stripe webhook idempotency tripwire (verify processorTxnId unique index, add test)

---
Last verified: 2026-08-01
