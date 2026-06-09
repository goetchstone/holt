# Accounts Receivable — design (ready-to-build)

The authoritative AR model for Holt. Supersedes the ad-hoc parts of Risk 3.
Goal: books that **reconcile to the GL**, support **both balance-forward and
open-item** AR without a hard mode switch, and never drift.

## Three layers (no new "AR balance" table — we already have them)

1. **GL control account** — `JournalEntry` / `JournalEntryLine` with an
   "Accounts Receivable" account. Total AR lives here.
2. **AR subledger (per customer)** — `CustomerLedgerEntry` (SALE / PAYMENT /
   REFUND) + cached `Customer.openArBalance`. This *is* the AR table; we finish
   wiring it.
3. **Open-item layer (per invoice, optional)** — NEW `PaymentApplication`
   allocating payments to specific invoices. Present only when a workflow needs
   invoice-level tracking; absent = balance-forward.

## Recognition triggers (accrual-correct)

- **AR debit** (SALE entry → subledger + GL): posted **when the invoice is
  issued / the order is fulfilled — NOT on a quote/draft order.** Amount = invoice
  total. You owe nothing until invoiced. Tie the entry to `invoiceId`.
- **AR credit** (PAYMENT entry): on payment received (incl. the Stripe/portal
  paths — Risk 1). REFUND mirrors.

## Open-item layer (the "in some cases" part)

New model:

```prisma
model PaymentApplication {
  id             Int      @id @default(autoincrement())
  organizationId Int
  paymentId      Int
  invoiceId      Int
  amountApplied  Decimal
  created        DateTime  @default(now())
  createdBy      String?
  // back-relations on Payment, Invoice, Organization
  @@index([invoiceId])
  @@index([paymentId])
}
```

Derived, never stored-and-trusted-alone:
- `Invoice.openBalance = invoice.total - SUM(applications.amountApplied) (- credits/refunds applied)`
- `Payment.unappliedAmount = payment.amount - SUM(applications.amountApplied)` → this is **on-account credit**.
- A payment may split across many invoices; an invoice may take many applications.

Both styles fall out of the same model:
- **Open-item:** create `PaymentApplication` rows → per-invoice open balance,
  per-invoice aging, statements, partial payments. (services / B2B terms.)
- **Balance-forward:** take the payment, create no applications → it's on-account,
  reduces the customer's overall balance. (retail deposits / counter.)

No per-tenant `arMode` flag needed — applying (or not) *is* the choice, per
payment. A tenant that never applies is balance-forward by behavior.

## Reconciliation invariants (the real "books are correct" guarantees)

1. **Per JE:** `SUM(debit) == SUM(credit)` — enforced at create + DB constraint (Risk 2).
2. **Subledger ↔ GL:** `SUM(Customer.openArBalance) == GL AR control-account balance`.
   This is the gold-standard tie-out we don't have yet. Add to the daily recon cron.
3. **Open-item ↔ balance-forward:** `SUM(invoice.openBalance) - SUM(payment.unappliedAmount) == customer.openArBalance == computeSourceBalance`.
4. Existing: subledger ↔ source (orders/payments), already reconciled.

## Aging + statements (what open-item unlocks)

- **Aging:** bucket each invoice's `openBalance` by `now - dueDate` (0-30 / 31-60 /
  61-90 / 90+). Balance-forward customers age on the customer balance instead.
- **Statement:** per customer — open invoices, their applications, on-account
  credits, running balance. Drives the portal + dunning later.

## Build order (each its own careful, real-DB-tested change — money code)

1. **Risk 1** — Stripe/portal payment → `appendEntry` (PAYMENT) in one tx. (gating)
2. **Risk 2** — assert balance at JE create + DB CHECK/trigger. (gating)
3. **Risk 3 (refined)** — post SALE entry on invoice issuance; add the
   **subledger ↔ GL** tie-out to the recon cron.
4. **Open-item** — `PaymentApplication` model + migration; invoice `openBalance`
   / payment `unappliedAmount` helpers (pure, A-grade tested); apply/unapply API +
   UI; per-invoice aging + statement; invariant #3 in recon.
5. **Risk 4** — align the ≤$1 snap (trace callers first).

## Real-world flows it must handle

These drive the model; getting them right is also a concrete reason a retailer
would adopt Holt over a tool that fudges them.

1. **50% deposit on a special order.** A deposit on an UNDELIVERED order is a
   **liability (Customer Deposits / unearned revenue)**, NOT a payment against AR
   — `Debit Cash / Credit Customer Deposits`. It becomes revenue + touches AR only
   on delivery. (Netting a deposit against the order total is the common wrong
   shortcut.)
2. **Partial deliveries.** Recognize revenue + AR **per delivery** — one order →
   multiple invoices (progress invoices). Each delivery: `Debit AR / Credit
   Revenue` for the delivered portion, and apply part of the deposit
   (`Debit Customer Deposits / Credit AR`).
3. **Partial payments.** `PaymentApplication` applies a payment/deposit across
   invoices/lines in partial amounts; remainder open or on-account.
4. **Invoice several items, customer disputes one, pays the rest.** Line-level
   **credit memo / adjustment**: disputed line credited or held in-dispute;
   payment applies to the undisputed lines; disputed amount tracked until resolved
   (credit / re-invoice / write-off).

### Model additions these force
- **Customer Deposits (liability)** — deposit at order time; applied to invoices
  on delivery. Distinct GL liability account; NOT negative AR. (operationally:
  a Payment flagged as deposit/unearned, tied to the order, applied on delivery.)
- **Progress / partial-delivery invoicing** — an order issues multiple invoices
  as items deliver; AR recognized per invoice.
- **Credit memo / adjustment** — line-level credit for disputes/short-pays
  (adjacent to the existing Return/refund path).

### Build slices (worst-first)
1. Open-item `PaymentApplication` + per-invoice open balance & aging (#3, most of #4).
2. Customer Deposits as a liability + apply-on-delivery (#1 properly).
3. Progress / partial-delivery invoicing (#2).
4. Credit memos / dispute handling (#4 fully).

Note: "operationally useful" (track deposits/balances) vs "accounting-correct"
(deposits as liability, per-delivery recognition) is a real choice — for a
"worthy" product that an accountant/auditor trusts, do the accounting-correct
version. Owner decides how far per slice.

## Non-negotiables (CLAUDE rules apply — this is money code)

- Reproduce-first, trace every caller before touching `paymentService` /
  `customerLedger`, real-DB integration tests proving each invariant.
- `Decimal` end-to-end; never float arithmetic on money.
- After any change touching money: re-assert the books reconcile.
