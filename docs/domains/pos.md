# POS — Counter Sales, Tills, Registers, Payments

Counter-sales workflow: register check-in, customer/cart build, payment recording, till open/close, gift cards, refunds.

This runbook covers the **ERP-native** POS path. Orders imported from the legacy POS flow through `docs/domains/import-pipeline.md` and `docs/domains/sales-orders.md` instead. The two paths share `SalesOrder` + `Payment` + `OrderLineItem` storage but use disjoint UI surfaces.

## Components

| Area                         | UI                                                                                                      | API                                                                                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cart + checkout              | `app/(dashboard)/app/sales/pos/PosView.tsx`                                                             | `pages/api/sales/orders/create-from-cart.ts` (order), then `pages/api/sales/orders/[id]/payments.ts` (tender)                                                                                                   |
| Till open/close              | `app/(dashboard)/app/sales/till/TillView.tsx`, `app/(dashboard)/app/sales/till/[id]/TillDetailView.tsx` | `pages/api/registers/[id]/tills/open.ts`, `pages/api/tills/[id]/close.ts`, `pages/api/tills/[id]/reconcile.ts`, `pages/api/tills/index.ts` (list), `pages/api/tills/[id].ts`, `pages/api/tills/[id]/summary.ts` |
| Register list / select       | (POS page header)                                                                                       | `pages/api/registers/index.ts`, `pages/api/registers/[id].ts`, `pages/api/registers/[id]/unblock.ts`                                                                                                            |
| Gift card on a sale          | `app/(dashboard)/app/sales/pos/PosView.tsx` (a `GC` scan)                                               | `create-from-cart.ts` (a `GIFT_CARD` line), issued by `lib/sales/giftCardLines.ts` with the payment that pays the sale off; see "Gift cards"                                                                     |
| Returns                      | `app/(dashboard)/app/sales/returns/*`                                                                   | `pages/api/returns/*` (see `docs/domains/returns.md`)                                                                                                                                                           |
| Receipt print (thermal 80mm) | `app/print/receipt/[id]/ReceiptPrintView.tsx`                                                           | `pages/api/print/order/[id].ts`                                                                                                                                                                                 |

Authentication is per-route, not one shared role list:

- **Permission-gated** (`requirePermission`): `sales.write` for `create-from-cart` (a gift card line included), `pos.operate` for the register list/detail and the register's gift-card lookups (`gift-cards/lookup.ts`, `gift-cards/presets/resolve.ts`), `pos.till.manage` to open a till, `pos.till.adjust` to clear a register block. `sales.read` ("View orders") for till detail (`tills/[id].ts`) and running totals (`tills/[id]/summary.ts`): it is the key of both till pages, so granting a role the till screens in Roles also grants their data. The till list (`tills/index.ts`) serves the Till screen and the Till Reconciliation report, so it takes `{ anyOf: ["sales.read", "reporting.read"] }`. The POS does not use it: it reads its register's open till as `openTillId` from `GET /api/registers/[id]` (`pos.operate`), so "Operate register" alone does not open every till's history.
- **Role-gated** (`requireAuthWithRole`): till close (`REGISTER`/`MANAGER`/`ADMIN`), till reconcile (`MANAGER`/`ADMIN`), order payments (`MANAGER`/`ADMIN`), Stripe create-checkout (`MANAGER`/`ADMIN`).
- **Session-only** (any signed-in user): `pages/api/print/order/[id].ts` (bare `getServerSession`).

REGISTER role exists specifically for counter staff; its POS-relevant permissions are `sales.write`, `sales.return`, `pos.operate`, `pos.till.manage` and `payment.take` — not `pos.till.adjust` (`lib/auth/permissionCatalog.ts`).

## Payment recording — `lib/paymentService.ts`

Source of truth for the ERP-native `Payment` writes — POS tender, refund processing, store-credit usage, gift-card redemption, and the PENDING→COMPLETED processor lifecycle. It is not the only writer: imported POS payments bypass this and go through `runPaymentsImport` (`lib/adapters/legacyPos/runners.ts`), and `lib/billing/invoiceService.ts` creates manually recorded invoice `Payment` rows with `tx.payment.create` directly (labelled from `INVOICE_PAYMENT_LABELS`). An invoice's card payment link is not one of them: it goes through `startHostedCheckout` like the order routes.

**A payment's label is its method, never its purpose.** `Payment.paymentType` is what the sales journal maps to a GL account (`POS_PAYMENTS`), so a card payment must read "Card". Until 2026-10-27 `pages/api/portal/pay.ts` and `pages/api/stripe/send-payment-link.ts` wrote their own PENDING rows and labelled a partial payment "Deposit", the journal's deposit OFFSET label: the card money posted to the wrong account and the daily reconciliation left it out of tender. Every hosted checkout now writes through `recordPendingPayment`, which labels by method and fills the customer. Whether a payment is a deposit is the journal's call, from the invoice date (`settlesOf`). Migration `20261027120000_card_payments_not_deposit` relabelled the existing rows.

**One label catalog.** `METHOD_DISPLAY` (`lib/paymentMethodDisplay.ts`) is the only place a method's label is written. `INVOICE_PAYMENT_LABELS` (`lib/billing/invoiceShared.ts`) is derived from it for the six invoice methods; `applyInvoiceCardPayment` (`lib/billing/invoiceService.ts`) looks up the card GL mapping by `METHOD_DISPLAY.CARD`; and the POS tender buttons and receipt (`PosView.tsx`), the till summary (`TillView.tsx`) and the till's payment list (`till/[id]/TillDetailView.tsx`) read their words from it. Until 2026-10-28 each of those had its own copy. `__tests__/onePaymentLabelMap.test.ts` is the ratchet: a method written next to its label, or a tender label in a `label:` field, fails anywhere outside `paymentMethodDisplay.ts` and the POS adapter's source vocabulary (`PAYMENT_METHOD_MAP`, which maps the other way).

**Payment types a store sets up (`Tender`, 2026-10-29).** The built-in methods are a fixed enum, and until this change the register offered Cash, Check, Card and Gift Card; invoices offered Cash, Card, Check, Wire, ACH and Other. `FINANCE` existed, but no screen could record it, and a store could not add the finance companies, Zelle or trade-ins it actually takes. Now Settings → Payment Types (`admin/setup/payment-types`, `/api/tenders`, `admin.settings`) keeps the store's own types. The rules live in `lib/payments/tenders.ts`, and the client-safe contract in `lib/payments/tenderShared.ts`:

- **A tender is a name on top of a built-in kind** (rule 62). The kind is one of `TENDER_KINDS` (Finance, Wire, ACH, Other), the methods with no machinery of their own. Cash, card, gift card and store credit keep their drawer, processor and balance logic and can't be configured.
- **A payment records the tender, not the method the caller sent.** `resolveTenderPayment` sets `method` to the tender's kind, `paymentType` to its name, `tenderId` and `reference`. It refuses a switched-off tender, or a missing reference when `referenceRequired` is set. Both writers go through it: `recordPaymentTx`, via `labelPayment` (the register), and `recordInvoicePayment`, via `labelInvoicePayment` (the invoice screen).
- **The name is a GL label**, so `tenderNameProblem` refuses a built-in's label and the deposit offset's (`DEPOSIT_OFFSET_LABELS`), and creating a tender creates its `POS_PAYMENTS` mapping on its kind's account (accounting.md). Once a payment uses a tender, its name and kind are fixed; it is switched off, never deleted.
- **Offered where the store says:** `atRegister` (the POS fetches `GET /api/tenders?for=register`, gated on `payment.take`) and `onInvoices` (tRPC `billing.tenders`).
- **Refunds go back to the same tender:** `processRefund` copies `tenderId` with the label and method.
- **The till card shows each tender as its own tile.** `calculateTillExpected` returns `otherByType`, the Other bucket split by `paymentType`, so the close can be checked against each finance company's approvals. Store tenders never count toward expected cash.

`Payment.reference` holds what the payer quotes, such as an approval or contract number. Before this change an invoice payment kept a reference only for a check, in `checkNumber`, and dropped every Wire or ACH reference typed on the invoice screen. `storeTenders.integration.test.ts` covers all of it.

**The payments route takes no processor ids from the browser.** `POST /api/sales/orders/[id]/payments` used to pass `processorType` and `processorTxnId` from the request body to `recordPayment`. `processRefund` sends a refund to the processor those two fields name. So a `payment.take` holder could post a "card" payment carrying another customer's charge id, then refund it onto that customer's card. No screen sent the fields; only `recordPendingPayment` (hosted checkout) writes processor payments. The route now drops them.

**One way to start an online card payment: `startHostedCheckout`.** Four sites used to paste the same sequence (block a second open session, open the provider's checkout, write the PENDING row): `pages/api/stripe/create-checkout.ts`, `pages/api/stripe/send-payment-link.ts`, `pages/api/portal/pay.ts`, and `lib/billing/invoiceStripe.ts` `createInvoicePaymentLink`. They now call `startHostedCheckout({ target: { orderId } | { invoiceId }, amount, actor, force, description, customerEmail, metadata, urls })` in `lib/paymentService.ts`, and keep only their own auth, balance rule, response shape and wording. It:

- refuses while `findActivePendingPayment(target)` finds a PENDING, non-refund row on the same order or invoice younger than `PENDING_SESSION_LIFETIME_MS` (24h), by throwing `CheckoutAlreadyOpenError` carrying that row's id, amount and age; with `force` it voids that row (`voidPendingPayment`, `updatedBy` = the actor) and carries on;
- opens the session on `getActiveProvider()` in `AppSettings.currency` (the three order routes used to send a `"USD"` literal);
- writes the row through `recordPendingPayment(target, …)`: method `CARD`, label `METHOD_DISPLAY.CARD`, `customerId` from the order or invoice, `processorType` from the provider (rule 60), and `salesOrderId` or `invoiceId`, the structural binding the webhook routes on.

The invoice path had no guard before this: every call opened a fresh checkout for the full open balance, so the email, the client portal and the staff "Copy payment link" could all leave parallel sessions on one invoice. How each caller answers an open checkout:

| Caller                                      | Answer                                                                                                                | Screen                                                                               |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `stripe/create-checkout` (staff, order)     | 409 `{ error, existingPayment }`; `force: true` replaces it                                                           | none calls it                                                                        |
| `stripe/send-payment-link` (staff, order)   | same                                                                                                                  | order detail "Send Payment Link": confirm in staff words, then re-sends with `force` |
| `portal/pay` (customer, order)              | 409 in customer wording; `force: true` replaces it (the token scopes it to their own order)                           | `PortalOrderView`: confirm in customer words, then re-posts with `force`             |
| `client-portal/pay` (customer, invoice)     | same as `portal/pay`, for their own invoice                                                                           | `ClientPortalView`: same confirm                                                     |
| tRPC `billing.paymentLink` (staff, invoice) | `CONFLICT`, message "A payment link for $X is already open on this invoice (started N min ago)."; input takes `force` | invoice detail "Copy Payment Link": confirm, then calls again with `force`           |
| `sendInvoiceEmail`                          | sends the email without the pay button and logs a warning naming the open checkout                                    | —                                                                                    |

The HTTP 409 bodies still say "retry with force:true" (a contract for API callers); no screen shows it. The customer screens word their confirm with `lib/openCheckoutPrompt.ts` from `existingPayment`; declining shows nothing. The order detail page also keeps its manager "Void" on a PENDING row (`payment.void`). A 500 from the three order routes now says only what failed; the cause goes to `logError` (rule 11). `hostedCheckoutLabels.integration.test.ts` pins the row each site writes and the invoice guard.

**A voided or failed checkout can still be paid.** Ending a PENDING row in Holt (a `force` replacement, the manager's void, the stale sweep) does not close the session at the processor. If the customer pays it anyway, the webhook finds no PENDING row. Both `pages/api/stripe/webhook.ts` and `pages/api/square/webhook.ts` then call `reportUntrackedCheckoutPaid(providerTxnId, provider.displayName)` (`lib/paymentService.ts`): when a VOIDED or FAILED non-refund row has that `processorTxnId`, it raises `reportOpsAlert` naming the payment id, status, amount and order or invoice, saying the money was taken and never posted, so someone must record or refund it. It never records the payment. A COMPLETED row (a retried webhook) or no row at all stays silent. `untrackedCheckoutPaid.integration.test.ts` drives both webhooks.

Key invariants enforced by `recordPayment()`:

- One `Payment` row per call. Each tender slice is its own
  `POST /api/sales/orders/[id]/payments`; the schema has always supported
  multiple payments per order, and `recordPayment` has always accepted any
  positive amount.

  **The register now takes partial payments.** It used to send the full order
  total on every payment, so a deposit — a furniture store's normal transaction —
  could not be rung up at all, and a customer splitting across two tenders needed
  two orders. The POS screen now offers an amount (defaulting to the balance
  due), refuses more than the balance, and stays on the payment screen while a
  balance remains so the next tender can be taken. Nothing changed on the money
  path: the limitation was entirely in the screen.

- Payment status follows the function that wrote the row, not the tender type. `recordPayment()` always writes `COMPLETED`. Processor checkouts go through `recordPendingPayment()`, which writes `PENDING` and posts NO ledger entry; `completePayment()` flips it to `COMPLETED` and posts the ledger entry when the webhook confirms. An unpaid `PENDING` row ends as `FAILED` via `expirePendingPayment()` (webhook expiry event, or the `sweepStalePendingPayments` backstop after 24h), or as `VOIDED` via `voidPendingPayment()` — either a `force` re-checkout replacing it, or the operator escape hatch at `POST /api/sales/orders/[id]/payments/[paymentId]/void` (`payment.void`). Voiding a payment that is no longer PENDING throws `VoidError`, which that route answers with 409 and its message (since 2026-10-30; `pendingPaymentLifecycle.integration.test.ts`).
- **Each move out of `PENDING` is one conditional UPDATE, and only the call that makes it writes anything else (ledger audit 2026-11-11).** `completePayment`, `voidPendingPayment` and `expirePendingPayment` each `updateMany … WHERE status = 'PENDING'` (`lib/paymentService.ts`); the loser of a race waits on the winner's row lock, then finds the row moved. They used to read the status and then update by id: two completions of one checkout (Square sends `payment.created` and `payment.updated` for one payment, and Stripe redelivers) both posted the `PAYMENT` ledger row, and a void or the stale sweep landing during a completion overwrote a just-`COMPLETED` payment, leaving its ledger row behind. Now `completePayment` returns `null` when it didn't make the move (already completed, or voided or expired first), and the webhooks then call `reportUntrackedCheckoutPaid`, which stays silent for a repeat and alerts for a voided or failed row. A void that loses answers `VoidError` ("payment N is completed"); an expiry that loses returns `null`. `completePayment` and `expirePendingPayment` never touch a refund row (`isRefund: false` in the condition). Tested in `paymentRaces.integration.test.ts`, which holds the customer's row so both requests are past their reads before either commits (`__tests__/helpers/locks.ts`); each race there failed on the code before (the card-and-recorded invoice race with the invoice lock taken out).
- `Payment.method` enum: `CASH`, `CARD`, `CHECK`, `GIFT_CARD`, `STORE_CREDIT`, `WIRE`, `ACH`, `FINANCE`, `OTHER`. Both `status` and `method` are nullable on the model, for imported rows. The string `paymentType` is the label: a built-in's `METHOD_DISPLAY` word or a store tender's name. A store tender's payment also carries `tenderId`, and any payment may carry a `reference`.
- **Customer-ledger atomic update** (Phase 0.5): every `recordPayment` runs inside a `$transaction` that ALSO appends a `CustomerLedgerEntry` and bumps `Customer.openArBalance`. The append is skipped only when there is no customer to ledger against (a walk-in on an unlinked order). Never skip the transaction wrap — drift detection (`lib/customerArDrift.ts`) will fire if the ledger and balance diverge.
- **Refund flow**: `processRefund()` writes a NEW `Payment` row with `isRefund=true` and `originalPaymentId` pointing at the original. The original is rewritten only for one status transition: once the refunds fully cover it, `processRefund` sets it `COMPLETED` → `REFUNDED`. The DB trigger from migration `20260428_payment_delete_immutability_trigger` rejects DELETE on `COMPLETED`/`REFUNDED`/`VOIDED` rows; UPDATE protection is deliberately deferred (that migration's header says why).
- **A refund the processor has can't be voided.** A card refund is reserved under the payment's advisory lock (`REFUND_LOCK_SPACE`, keyed on the original payment) and committed `PENDING`; then `callProcessorAndSettle` takes that lock again, in a transaction that writes nothing before the processor call, and holds it through the call and the settle (`REFUND_CALL_TX`, a 5-minute limit, past Stripe's 80s timeout tried three times). `voidPendingPayment` on a refund row tries the same lock (`pg_try_advisory_xact_lock`) and answers `VoidError` ("with the card processor right now") if it's held. It used to void the row mid-call: the processor paid out, the settle found no `PENDING` row and returned success, so the money left with no `REFUND_ISSUED` row and the voided refund freed the cap to refund it again. Once the processor has said no, the lock is free and the refund can be voided as its message says. A void that lands between the reserve and the call wins, and the call then refuses to send anything (`RefundError`). A retry (`retryProcessorRefund`) waits on the lock and finds a refund another retry settled. Tested in `paymentRaces.integration.test.ts` ("a refund waiting on the card processor").

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

**A card's balance changes only when money moves (owner, 2026-11-11).** "If we can void something and the money disappears, that is not good accounting practice", and "everything must be transactional, be on a ledger". So:

- **`lib/giftCardLedger.ts` is the one way a balance changes.** `spendFromCard` (the register's `GIFT_CARD` branch in `recordPaymentTx`), `creditToCard` (a refund back to the card, a reload sold on a sale), `issueCard` (a card sold on a sale: ACTIVE, with an `ISSUANCE` row from $0; a number in use is refused), `takeBackFromCard` (a live card line cancelled or returned: a negative `REFUND` row, refused if the balance is short) and `replaceCard`. Each is a single conditional UPDATE in the caller's transaction with its `GiftCardTransaction` row: Postgres locks the card's row and re-checks the condition, so two spends of one balance can't both pass and a closed card is never touched. A card spent to $0 is `REDEEMED` and can be reloaded and used again.
- **A history row's `amount` is the signed change**: negative when value leaves the card, so `balanceBefore + amount = balanceAfter` and a card's rows add up to its balance (pinned by `giftCardLedger.integration.test.ts` on every card it touches). Rows written before 2026-11-11 aren't consistent (a standalone redeem wrote positive, Adjust an unsigned amount, an import its first value).
- **No Void, no Adjust.** Both routes are gone, with the standalone `[id]/redeem.ts`, which nothing called. A card is retired only by **moving its balance to a new card** (`[id]/replace.ts`, "Move to a New Card" on the card's page): the owner's "issuing a new one using the old one to pay for the new one". The old card ends `REPLACED` at $0 with `replacedById` pointing at the new one; a `TRANSFER` row on each card records the move. `VOIDED` stays in the enum for cards voided before; nothing writes it.
- **A refund of a payment made with a card** goes back on that card as a `REFUND` row, unless the card was retired: then the refund is refused with "Refund it to store credit instead" (owner: staff choose; the refund destinations today are the original payment or store credit).
- **A re-import** (`gift-cards/import.ts`) fills in only a card nothing has touched since it came in: it locks the card, takes the report's balance with an `IMPORT` row for any change, and refuses a card that was retired or used in Holt, saying which (Holt is the record once a card is here). An unreadable amount is reported, not read as $0.
- **Who may write a card** is a list with a reason for each (`__tests__/giftCardWriters.test.ts`, rule 65): the ledger module, the import, the notes route and the demo seed, whose cards now carry their issue row so their history adds up too. Selling a card writes none itself: `lib/sales/giftCardLines.ts` issues it through the ledger.
- `GiftCard` has `initialAmount` + `currentBalance`. Barcode is the redemption identifier.
- **A card is sold and reloaded as a line on a sale (owner, 2026-11-11)**, rung up at the register and paid like any sale; its value is a liability, not revenue, until spent. "The card goes live when the sale is paid in full", and "it also must be paid in full". The gift-card sale screen, `activate.ts` (a card with no payment), and the card page's Reload with `[id]/reload.ts` are gone.
  - **At the register** (`PosView.tsx`): a `GC` or `GC<n>` scan (`startCardLine`) opens a card form with the amount from that code's `GiftCardPreset` (`gift-cards/presets/resolve.ts`; a bare `GC` with no preset of its own takes a typed amount) and the card's number to scan. `addCardLine` looks the number up (`gift-cards/lookup.ts`): an open card is a reload, an unknown number a new card, a retired one is refused with `closedCardMessage` (`lib/sales/giftCardLineShared.ts`, which the gift-card tender's lookup uses too). Card lines are kept beside the product cart (`cardLines`), so no quantity, discount, price edit or stock applies to them; in Return Mode a `GC` scan is refused.
  - **The line** is `GiftCardCartLine` (`{ type: "GIFT_CARD", giftCardNumber, amount }`) in `lib/sales/giftCardLineShared.ts`, the one contract both sides import (rule 7). `create-from-cart` splits the cart into goods and card lines. `checkGiftCardLines` (`lib/sales/giftCardLines.ts`) refuses a line with no number, a number twice on one sale, an amount that isn't whole cents above zero (`parseCardAmount` and a whole-cents check), a retired card, any card while the Gift Cards module is off, and any card beside a return line (no exchange onto a card: the return's credit would pay for it with no payment, and a $0 sale has no payment to issue it). The goods alone are priced, taxed, held and judged for discount; each card is written after them (`cardLineRows`): `productId` null, `productName` "Gift card" or "Gift card reload", `partNo` "", `orderedQuantity` 1, `netPrice` and `listPrice` the amount, `vatRate`/`vatAmount` 0, `cost` 0, and `giftCardNumber`. The response's `subtotal` and `total` include the cards; the order's `totalTax` doesn't.
  - **What it isn't** (each read in source): stock (create-from-cart allocates product lines only, and `getActiveOrderLines` in `orderInventorySync.ts` reads `productId: { not: null }`), a PO (`raiseSpecialOrderPos` skips a line with no product vendor), a delivery piece (the register counts products; `deliveryFee.ts` `orderPieces` reads `COUNTED_ITEM_LINE`), taxed or discounted (it isn't in `priceCart`'s input: a card sold for less than it holds puts money on it nobody paid). Revenue, reports and the journal leave it out through `COUNTED_ITEM_LINE`; what the customer owes (`computeBalance`) keeps it in.
  - **Issued with the payment that pays the sale off**, in that payment's transaction: `issuePaidGiftCards(tx, orderId, actor)`. Every path that can pay an order off calls it (rule 42): `recordPaymentTx` (the register's tenders through `orders/[id]/payments.ts`, the order screen's Apply Store Credit, and `refundReturn.ts` applying a return's credit to what the original still owes), `completePayment` (the Stripe and Square webhooks, which the portal's Pay and payment links reach), and each change that lowers what's owed with no payment to follow: the line route's cancel, update, replace and remove transactions, and `setDeliveryFee`. With a card line waiting (counted, a number, no `giftCardId`) it locks the order (`FOR NO KEY UPDATE`, so two tenders landing together decide one after the other), and issues only when what's owed less what's paid is $0 or less exactly: not `balanceDue`, which reads up to $1.00 owed as paid. Each line is issued as it was rung up (`cardLineIntent`, from the line's `productName`, "Gift card reload" or "Gift card"): a reload gets `creditToCard(…, "RELOAD")` on its open card, a new card `issueCard`, each with reference "Order <orderno>" and the row's `orderLineItemId` set to the line (the journal reads it, below); then the line's `giftCardId` is set, so it's issued once. An advisory lock on the number (`CARD_NUMBER_LOCK_SPACE`) makes two sales issuing one number decide in turn. `issueProblem` refuses a reload whose card was retired (or is missing) since it was rung up, and a new-card line whose number another sale has issued since: a new card never reloads a card someone else holds. What happens then is the caller's (`onProblem`): the register's payment (`recordPaymentTx`) refuses, so the error shows and no money moves; a processor's payment (`completePayment`) and a line change have moved money already, so they `leave` the line unissued, log it (`logError`) and record why on the order once (`OrderChangeLog` `GIFT_CARD_NOT_ISSUED`), and the payment completes; staff cancel the unissued line, which gives its money back. Invoice payments don't issue (they pay an invoice, not an order's balance), nor does the payments import (onboarding; its orders have no card lines).
  - **No deposit on a sale with a card.** `create-from-cart` answers `allowSaleWithoutPayment: false` for it, so the register doesn't offer to go ahead unpaid; the amount hint says it's paid in full now, split across tenders if need be (`PayAmountHint`); once part is paid, "Skip payment" gives way to what's still due (`SkipPayment`). The server doesn't refuse a part payment: a payment link's deposit or the order screen can still take one, and the card waits for the rest.
  - **After the sale is written**, a card line is the card's number and the money paid for it. `giftCardLineChangeProblem(db, line, action)` (`lib/sales/giftCardLines.ts`) is the one gate: it refuses changing its price, quantity or product (update, replace, relink, hold), lets a note on, lets a line whose card isn't issued be cancelled or taken off a quote, and sends a live card's cancel or return to `liveCardRefundProblem` (below). The line route (`orders/[id]/line-items/[lineItemId].ts`, beside `deliveryFeeLineEditProblem`), a whole-sale cancel (`cancelOrder.ts` `cancelProblem`, ACTIVE lines), a new return (`returns/index.ts`) and `takeBackCardLine` all ask it (rule 42). The direct refund route (`orders/[id]/refunds.ts`) asks `directRefundProblem` inside the refund's transaction (`processRefund`'s `guard`) and refuses a refund on a sale with a live card line (counted, issued, its value not taken back), pointing at the line's cancel or return, so a card's money never goes back without the card. A card line isn't goods: a handover (`fulfilment/handover.ts`) marks only `isCountedItemLine` lines fulfilled, and the line route never reads a card line as gone to the customer, so a handed-over sale's card can still be cancelled where the store refunds cards. A register sale is a quote until its first payment, so a quote can hold a card line: re-rating a quote's tax (`rerateQuoteTax.ts`) and the quote reports (`staleQuotes.ts`, the pipeline detail, `COUNTED_QUOTE_LINE`) read `COUNTED_ITEM_LINE`, and copying a sale (`duplicateOrder.ts`) leaves the card out.
  - **In the books** (`lib/journalEntry.ts` `CardLineMove`): the money paid for a card line is booked like any payment on its order, into the deposit liability before the order is invoiced and against the receivable after. On the day the card is issued, the sales journal moves it to the gift card liability (the account `POS_PAYMENTS`/"Gift Card" maps to, the one a redemption debits): Dr deposits (memo "Deposits to gift cards") or Dr AR, Cr 2-2127 ("Gift cards sold"). It reads the card's own ledger rows tied to a sale line (`SALE_LINE_CARD_ROW` in `giftCardLedger.ts`), so a take-back books the reverse. Accounting detail and the reconciliation: `accounting.md`, 2-2127.
  - **Refunding a live card is the store's call** (owner: "Most places will not refund a giftcard ... this should be a config and then only if unused"). `AppSettings.giftCardsRefundable`, off by default, is "Refund unused gift cards" in Admin › Settings (`SettingsOverviewView.tsx` `GiftCardRefundSection`; `parseGiftCardsRefundable` in `api/admin/settings/index.ts`, audited with the other settings as `SETTINGS_SAVED`). `liveCardRefundProblem` refuses a live card's cancel or return while it's off, naming the setting; when it's on, it allows one only if the card is unused: open, still holding the line's whole amount, and no row taking value off it since the row that line issued or reloaded it with. A return is for a sale that was invoiced, as with goods; before that the line is cancelled.
  - **Taking it back** is `takeBackCardLine(tx, lineItemId, actor, { action })`: it locks the line and the card, asks the gate again, and writes `takeBackFromCard` (a negative `REFUND` row with the line's `orderLineItemId`), once per line. A second take-back of a line refuses ("already been taken back"), so a cancel sent twice can't refund or credit twice, unless the caller is `finishing`: moving no money for the card of its own (a whole-sale cancel's later refunds, held to what was paid by each payment's cap; the line cancel's last step after its own refund; a cancel finishing one that refunded and stopped). A line cancel takes it back with its first refund only. The card goes to $0 (`REDEEMED`), or back to its balance before a reload. It runs in the transaction of the money that goes back, and the existing flows return the money: a whole-sale cancel (`cancelOrder.ts` `takeBackCards`, as the first `processRefund`'s `guard`, and again in `closeTheSale` for credit or a refund already made), cancelling the line (`refundOverpayment`'s `guard` via `takeBackLineCard`, and the line route's cancel transaction), and a return (`bookReturn.ts`, when the return is booked at its first refund: whole, with no restocking fee, and its own negative line a card line, so it reverses no revenue).
  - Tested in `__tests__/integration/giftCardSale.integration.test.ts` (the race test fails with the lock taken out) and `giftCardSaleBooks.integration.test.ts` (the journal and reconciliation for a card sold alone and with a sofa delivered later; refused with the setting off and once spent; cancelled by line, by the whole sale and after a reload; returned; a direct refund refused; a stale second cancel refused; a handed-over card cancelled; a card issued by cancelling goods down to what's paid; a card beside a return refused; a processor's payment completing with its card left unissued; a new card refused on a number another sale issued; a day with no "Gift Card" mapping refused).
  - **Still open**: the server doesn't refuse a part payment on a sale with a card (above), and a line cancel split across several payments that stops after its first refund can't be finished by cancelling again while money is still owed back for the card (the second refund refuses as already taken back): the rest goes back by hand once the line's value is off the card.
- **Legacy POS gift-card sales were never imported** until the Phase 0.5.6 backfill — historical liabilities are reconstructed from a POS "card # / amount / date activated" report (one-off).

## Stripe integration

Stripe is no longer the only processor: checkout creation and webhook verification sit behind a provider seam (`lib/payments/`, with `stripeProvider.ts` and `squareProvider.ts`), and the routes resolve a provider rather than calling Stripe directly.

- `lib/stripe.ts` — Stripe client resolution only (secret key DB-first from Settings, `STRIPE_SECRET_KEY` env fallback) plus the `STRIPE_TEST_EMAIL_OVERRIDE` escape hatch. Checkout-session creation and signature verification live in `lib/payments/stripeProvider.ts`.
- `pages/api/stripe/create-checkout.ts` — creates a checkout session for an order's balance through `startHostedCheckout` (whichever provider is active), returns the redirect URL; the `PENDING` `Payment` row is written via `recordPendingPayment` (no ledger entry yet).
- `pages/api/stripe/webhook.ts` — Stripe's delivery endpoint. Signature verification is mandatory: with no webhook secret configured the route rejects outright. On a completion event it finds the `PENDING` `Payment` by `processorTxnId` and calls `completePayment`, which in one transaction sets it `COMPLETED`, posts the ledger entry, issues an order's paid gift cards, and for an invoice's checkout writes its `PaymentApplication` and `AR_PAYMENT` journal (`applyInvoiceCardPayment`, `lib/billing/invoiceService.ts`). If any of that throws (a missing `POS_PAYMENTS`/"Card" mapping, a metadata invoice that isn't the row's), nothing is written, the row stays `PENDING`, the route alerts and answers 500, and Stripe's retry finds the row and posts it whole. Before 2026-11-13 the invoice step ran in a second transaction after the ledger entry committed, and a retry never came back for it: the customer ledger said paid while the invoice stayed open. When `completePayment` made the move, the route then runs `onPaymentReceived` (quote promotion, special-order POs); that step is not money and is not retried, since a retry finds the row `COMPLETED`. When it didn't, or with no `PENDING` row at all, it calls `reportUntrackedCheckoutPaid` (above). It also handles `checkout.session.expired`, ending the `PENDING` row as `FAILED`. `pages/api/square/webhook.ts` is the same below its signature check.
- **Idempotency**: `processorTxnId` is **not** unique on `Payment` — there is no unique index on it and no INSERT-on-conflict anywhere. Retried and doubled deliveries are safe because `completePayment`'s move is conditional on `PENDING` (above): of two at once, the second writes nothing. Stripe retries are normal and frequent, and Square sends two completion events per payment.
- Customer portal exposes a payment link per-order at `/portal/order?token=…`, which posts to `pages/api/portal/pay.ts` (JWT token auth, no login, rate-limited at 5/min per IP).
- `PaymentProvider.isConfigured()` answers whether the processor's credentials resolve, with no network call: Stripe needs its secret key, Square its access token and location id, each through the same `getStripe()` / `getSquareCredentials()` a payment uses. The Admin hub's getting-started checklist asks it of the active provider; "We take cash and checks only" (Settings → Integrations, `AppSettings.cashOnlyAcknowledgedAt`) satisfies that item instead. Tested in `__tests__/paymentProviderConfigured.test.ts`.

## A product's line price

A scanned or searched product goes onto the cart at its retail price, from
`lib/pos/cartPricing.ts:catalogRetailPrice`. New Quote uses the same helper. A
product with no retail price is refused with a message naming where to set it
(`noRetailPriceMessage`), and the search results label it "No price"
(`components/sales/RetailPriceTag.tsx`). Zero counts as no price, because an
import or `products/quick-create.ts` writes 0 where there was none.

Until 2026-10-27 both screens priced such a product at two and a half times
its cost, one business's markup (USE-04b). The server could not have caught
it, since `create-from-cart` takes the client's unit price (step 1 below), so
the refusal lives in the screens. `__tests__/noInventedMarkup.test.ts` fails on
any new cost times a constant in `src`, and on either screen pricing without
the helper. A cashier can still change a line's price once it is on the cart.

## Order creation from cart

`POST /api/sales/orders/create-from-cart` (`pages/api/sales/orders/create-from-cart.ts`):

1. Reject an empty cart, and a gift card line that can't be sold
   (`checkGiftCardLines`, "Gift cards" above); there is no product-exists,
   qty > 0 or price-sanity check here. Line money is computed
   by `lib/pos/cartPricing.ts:priceCart`, the same module the POS screen
   prices with, so the stored numbers can't diverge from what was charged.
   The order discount is split across positive lines by cumulative rounding.
   The shares sum to the discount exactly, none is negative, and none exceeds
   its line. The old "last line takes the remainder" split gave four $0.01
   lines with $0.02 off the shares [.01, .01, .01, -.01]. This is fuzzed in
   `__tests__/fuzz/cartPricing.fuzz.test.ts`.
2. Compute tax via `src/lib/tax/resolveTaxRate.ts`: customer exemption
   (`Customer.taxExemptReasonId`, copied onto the order as
   `SalesOrder.taxExemptReasonId` so Tax Summary files the sale as exempt), then
   the customer's own district override, then the selling store's district
   (`StoreLocation.taxDistrictId`), then `AppSettings.defaultTaxDistrictId` —
   never a hardcoded district. Rate is then banded per line against each
   line's discounted amount (`TaxRule.triggerPrice`/`startPrice`/`stopPrice`),
   not a single flat percentage for the whole order. See that file's header
   for the full order and what it deliberately does not evaluate yet
   (chained rules, tax-included pricing, per-product tax groups).
   When the active store resolves no district (none of its own, no default),
   the sale still goes through at 0% tax, and the POS shows an amber banner
   saying so (`components/sales/NoTaxDistrictBanner.tsx`, USE-08). The fact
   comes from `taxDistrictConfigured` on `GET`/`PUT /api/staff/active-store`
   through `useActiveStore`; the rule is `taxDistrictConfigured()` in
   `lib/gettingStarted.ts`, unit-tested in `__tests__/gettingStarted.test.ts`.
3. Generate orderno via `lib/orderNumber.ts` `nextOrderNumber()`:
   `<prefix>-YYMMDD-NNN`, the prefix from `AppSettings.orderNumberPrefix`, else
   the business's initials (`lib/numberingPrefix.ts` `effectivePrefix`, #192).
   It carries no store code (per-store prefixes are master plan G1 / Phase 1)
4. Create `SalesOrder` (at `status: "QUOTE"`) + line items in one transaction.
   Inventory allocation runs inside that same transaction, over PRODUCT lines
   only — CONFIGURED/CUSTOM lines mint a new `Product` here and have no stock
   position by construction.
5. No payment is recorded here. The POS posts the tender separately to
   `POST /api/sales/orders/[id]/payments`, which calls `recordPayment` and then
   `onPaymentReceived` — that is what promotes QUOTE → ORDER and creates the
   draft POs.
6. With `deliveryMethod: "DELIVERY"` and a `deliveryFee`, write the fee through
   `setDeliveryFee()` in the same transaction (sales-orders.md, "Delivery fee").
   A fee on a sale that isn't a delivery is a 400, and so is one while
   POS Transactions/"Delivery Fee" is unmapped; either way no order is written.
   The register's fee field (`sales/pos/DeliveryFeeField.tsx`) fills in the zone's
   fee from `GET /api/sales/delivery-fee-quote` and follows the zone until staff
   type their own. The order also records `storeLocationId`, which it didn't before.
7. Before the transaction, judge the sale's discount (pos.md, "Discounts and
   manager approval"). A discount past what the seller may give is a 403 with
   `code: "DISCOUNT_APPROVAL_REQUIRED"`, and no order is written; resent with a
   manager's `discountApproval`, it goes through and the approval is logged.
   Each line records `listPrice`.
8. Return the order id plus the server-priced subtotal / order discount / delivery
   fee / tax / total.

## Splitting a sale (GAP-07, since 2026-11-03)

Someone with "Reassign salesperson" sees **Split the sale with** on the
register and the quote builder: a colleague, and their own share (the store's
default from Admin › Settings › Split sales, 50 to start). `create-from-cart`
takes `splitWithId` and `splitPercent`, refuses a split from anyone without the
permission (403), a partner who is the seller, gone or unknown, and a share
outside 1-99, and records the share on the order. Every report then credits the
seller their share and the partner the rest (commission.md "Split sales").

## Discounts and manager approval

**A discount follows the store's policy (GAP-06, 2026-10-30).** How a store
runs discounts is its own business (owner: "some businesses may let everyone
apply a discount, some may have a limit, and other may always need a
manager"). Holt ships the locked-down choice. `lib/sales/discountApproval.ts`:

- **Who may discount alone.** A role holding "Apply discounts" (`sales.discount`,
  read through the gate's `also` so impersonation is honoured) may give any
  discount. Anyone else may take up to `AppSettings.discountLimitPercent` off a
  line (Settings › Discounts). That defaults to 0, so every such discount needs a
  manager until the store loosens it.
- **What counts.** A line sold below its list price: a discount entered at the
  register, a price typed below the product's retail (`catalogListUnits`), a
  replacement or price edit below the line's recorded list, or a delivery fee
  below its zone's (a waived fee is 100%). It is measured per line
  (`largestDiscountPercent` in `lib/sales/discountPolicyShared.ts`), so a deep
  cut on one small line can't hide in a large sale. Returns are not discounts.
- **Approval.** The screen (`components/sales/useDiscountApproval.tsx`) shows the
  managers who can approve: active staff holding the permission, with a PIN set
  (`GET /api/sales/discount-approvers`). The chosen manager enters their PIN, and
  the request is sent again with `discountApproval: { approverId, pin }`.
  - The PIN is checked before the sale's transaction, so a wrong try counts even
    though the sale is refused. Five wrong tries lock the PIN for fifteen minutes.
  - An approval is an `OrderChangeLog` row, `DISCOUNT_APPROVED`, naming the
    manager and the percent.
- **Every route that can sell below list calls `authorizeDiscount()`**:
  - `create-from-cart` (the register and New Quote);
  - `orders/[id]/line-items` (add a line);
  - `line-items/[lineItemId]` (`update` with a price, and `replace`);
  - `orders/[id]/delivery-fee`.

  A route called directly with no `access` (as the integration tests do) holds
  nothing extra, the locked-down default.
- **The saving.** `OrderLineItem.listPrice` is the unit price a line was listed
  at; lines written before 2026-10-30 have none. The order screen shows "List …
  · saved …" under a discounted line, and the receipt and the printed invoice
  show "You saved".
- **Not covered:**
  - B2B proposals and the HD proposal import price their own lines and do not go
    through this;
  - a configured (made-to-order) line's list is the price the configurator
    sent, so a configured price typed lower is not caught.

  Both are in ROADMAP (GAP-06). The POS then shows its own take-payment panel; it does not navigate to
   the receipt-print page (see the auto-print gap below).

## Receipt print

`app/print/receipt/[id]/ReceiptPrintView.tsx` — 80mm thermal, 203 DPI. The receipt is drawn onto a canvas at 640px wide (80mm at 203 DPI) and printed as a bitmap, not as HTML text. The browser handles the print dialog. The printed page is 80mm wide and exactly as long as the drawn receipt (`lib/receiptPage.ts` `receiptPageRule`, two lengths). It asked for `size: 80mm auto` until 2026-10-17 -- invalid CSS, so the browser dropped it, the global landscape-Letter `@page` in `globals.css` won, and "Save as PDF" gave an 11x8.5in page with a strip of receipt on it (measured with headless Chrome; `__tests__/receiptPage.test.ts`). The store tagline (`AppSettings.tagline`) prints under the name and the store's returns note (`AppSettings.receiptFooter`, Admin -> Settings) at the foot, so both must be written for customers; an unset footer prints nothing. Order data comes from `pages/api/print/order/[id].ts`, which is session-checked but NOT rate-limited — the 30/min limiter is on `pages/api/print-label.ts`, a different surface.

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
| `lib/giftCardLedger.ts` (every balance change)                            | `__tests__/integration/giftCardLedger.integration.test.ts`: two spends of one balance, $0 to Redeemed and a reload, a refund back on the card, moving a balance to a new card, a retired card refused everywhere, a re-import, and every card's history adding up |
| `lib/customerLedger.ts` (atomic ledger append)                          | Unit + real-DB integration                                                                                                                                                                                                                                      |
| `lib/tillVariance.ts` (classifyTillVariance, threshold boundaries)      | Unit tests in `__tests__/tillVariance.test.ts`                                                                                                                                                                                                                  |
| Till close/reconcile/open/unblock (variance discipline, register block) | Real-DB integration in `__tests__/integration/tillVarianceEnforcement.integration.test.ts`                                                                                                                                                                      |
| PENDING-payment lifecycle (find-active / void / expire / sweep)         | Real-DB integration in `__tests__/integration/pendingPaymentLifecycle.integration.test.ts`                                                                                                                                                                      |
| Stripe and Square webhook routes                                        | Real-DB route tests with the provider's verification stubbed: `untrackedCheckoutPaid.integration.test.ts` (no `PENDING` row) and `paymentRaces.integration.test.ts` (two completions at once post once; an invoice's checkout posts whole or not at all, and the retry posts it). Signature verification itself has no route test; `__tests__/stripeProvider.test.ts` covers `extractExpiration` |

## Known gaps (master plan Phase 1)

- **G1**: per-store sales prefix config — the orderno prefix is configurable per business since #192 (`AppSettings.orderNumberPrefix`), but there is no per-store code in it yet
- **G2**: shipped — `lib/inventory/allocation.ts` commits free stock at order creation (`allocate`, inside `create-from-cart`'s transaction), deletes it at `FULFILLED` (`consume`) and returns it at `CANCELLED` (`release`). Overselling is deliberately still allowed: `allocate` records a shortfall and never blocks the sale.
- **G3**: receipt auto-print on order confirmation
- **G8**: `CashMovement` model + UI for intra-day non-sale cash flow
- **Split tender UI**: schema supports multiple Payments per order; the POS tenders the whole order total in a single call
- **C8**: shipped 2026-11-13 — completion idempotency rests on `completePayment`'s conditional `PENDING` → `COMPLETED` update (still no `processorTxnId` unique index), tested with two deliveries at once in `paymentRaces.integration.test.ts`.

---

Last verified: 2026-08-01
