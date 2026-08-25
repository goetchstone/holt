# Revenue Recognition — the delivery policy, and the work to implement it

## The policy

Set by the product owner, 2026-08-25. This is the ground truth every item below
serves:

> Anything not delivered is a promise, not a sale. We may report the sales data
> in reports and dashboards, but those sales are in accounting deposits and
> liabilities until delivered. Anything delivered generates the "invoice", which
> then moves the money from deposits and makes the journal entries for the sales
> and tax etc.

and:

> same with a pickup too

### Two bases, both legitimate

| Basis | Means | Where it is correct |
| --- | --- | --- |
| **Bookings** | Every order written, whatever its state | Reports, dashboards, commission, sales targets |
| **Recognised** | Only what has been handed over | The general ledger, the daily control, anything exported to accounting |

Reports being on a bookings basis is **not a bug**. See "Reports keep bookings"
at the end — that list exists so nobody "fixes" it later.

### What counts as handover

`SalesOrder.deliveryMethod` already models three, set in
`create-from-cart.ts:52`. All three are the same accounting event — the goods
left the building.

| Method | Handover moment |
| --- | --- |
| `DELIVERY` | the delivery stop completes |
| `PICKUP` | the customer collects |
| `TAKEN` | at the till — cash-and-carry, delivered immediately |

---

## What is actually true today

Established by reading the code, and each load-bearing claim independently
verified by an adversarial check.

### 1. Delivery has no accounting consequence at all

There is **no code path** that creates or issues an `Invoice` as a consequence
of any delivery, dispatch, stop completion, run completion or appointment
completion. Every `Invoice` writer is one of three: the billing UI
(`invoiceService.ts:234`), the Ordorite CSV importer (`runners.ts:2468`), or the
demo seed (`salesOrders.ts:278`).

A signed, photographed, physically completed delivery leaves the `SalesOrder`
**completely untouched**: the driver flow (`DriverView.tsx:141,146,163`) writes
only `DeliveryStop` and `DeliveryRun` rows. The order keeps `status = ORDER`, its
inventory stays committed, and its money stays a deposit — permanently, unless a
human separately clicks a different button on a different screen.

### 2. There are two `FULFILLED` flags and they can disagree forever

`SalesOrder.status` (`schema.prisma:2455`) and `SalesOrder.dispatchStatus`
(`:2470`) are written by two different endpoints, and **neither writes the
other's field**:

- `PUT /api/sales/orders/[id]` writes `status` only (`[id].ts:46-57`)
- `PUT /api/sales/orders/[id]/dispatch` writes `dispatchStatus` only (`dispatch.ts:43-53`)

So `status=FULFILLED / dispatchStatus=PO_PLACED` is a reachable, persistent
state. There is no single field meaning "delivered".

Neither endpoint checks that a delivery happened — the only validation is that
the string is in a hardcoded list (`[id].ts:26`). **A salesperson can mark an
order FULFILLED from a dropdown with no delivery evidence of any kind.** That is
why the invoice trigger must not hang off these.

`consume()` — the code representing goods physically leaving — has exactly two
callers, both of those status endpoints. The delivery record never calls it.

### 3. A deposit is never relieved

`depositGlId` is used at exactly one site (`journalEntry.ts:493-498`), on the
**credit** side, inside `if (!order.hasInvoices)`. The invoiced branch never
touches it.

So a deposit taken in May and delivered in July posts:

```
July:   Cash        1,800 Dr
        COGS        1,500 Dr
        Over/Short  1,200 Dr   <- the plug
          Sales                    3,000 Cr
          Inventory                1,500 Cr
```

The May deposit sits in Customer Deposits forever, and the P&L carries a fake
1,200 expense. The entry balances, so nothing complains.

Measured, not inferred — `__tests__/integration/depositRecognition.integration.test.ts`
reproduces it.

### 4. Revenue is recognised once per payment DAY, not once per sale

`processedOrders` (`journalEntry.ts:448`) is scoped to a single
`buildJournalLines` call. An invoiced order paid in two instalments recognises
the **full order on both days**:

```
DAY 1:  Sales 3,000 Cr   COGS 1,500 Dr   (+ Over/Short 1,800 Dr)
DAY 2:  Sales 3,000 Cr   COGS 1,500 Dr   (+ Over/Short 1,200 Dr)
```

6,000 of revenue for a 3,000 sale, inventory relieved twice, the plug hiding it
both times. The file already documents this exact failure shape — for refunds,
where it was fixed (`journalEntry.ts:~505`). The same shape was left open for
ordinary multi-day payments.

### 5. Two independent recognition engines

`issueInvoice` posts its own `POSTED` journal — `ARI-<invoiceNo>`, type
`AR_SALE`, Dr AR / Cr Revenue / Cr Tax (`invoiceService.ts:339-357`). So an
order-linked invoice would be recognised **twice**: once by `ARI-*`, once by the
day's `SJ*` as soon as `hasInvoices` flips.

This is **latent, not live**: `salesOrderId` is not in the tRPC router's
`draftInput` (`billing.ts:38-43`), so no production caller can link an invoice to
an order. The service layer gained the parameter in #134; the router did not.
**Any step that makes it reachable must land the guard first.**

Also: `postJournal` writes `journalDate: new Date()` — an instant — while
`generateSalesJournal` writes UTC-midnight markers. So AR journals silently never
match the reconciliation's lookup (`dailyReconciliation.ts:427-433`). That is an
accident of a timestamp mismatch, not a design.

### 6. The reconciliation compares two different bases

`source.revenue` sums `OrderLineItem.netPrice` for orders whose `orderDate` falls
in the day and whose status is in `SALES_REVENUE_STATUSES` — which includes
`ORDER` (`dailyReconciliation.ts:388-412`). That is bookings. The journal side is
gated on `hasInvoices`. So every un-delivered order written today reports as
revenue **drift**, permanently, on every deployment that takes special orders.

---

## Imported history expresses the same policy

Saybrook's invoicing came from a **report downloaded out of Ordorite**, and that
report already encodes the policy exactly:

| In the downloaded report | Means | Accounting |
| --- | --- | --- |
| An invoice row exists for the order | delivered — a **closed** sale | recognised |
| No invoice row | still a promise — an **open** sale | deposit / liability |

`runInvoicesImport` (`runners.ts:2367`) reads six columns — `Invoice No`,
`Invoice Date`, `Part No`, `Product/Service Quantity`,
`Product/Service Sales Tax`, `Tax Amount` — and already promotes any order that
gains an invoice to `FULFILLED` (`:2529-2536`). That promotion is the policy
running backwards, which is right for a *reconstruction*: when rebuilding
history, the invoice **is** the surviving record that delivery happened. Going
forward the arrow runs the other way — delivery generates the invoice — and both
directions agree on the same fact.

### The importer writes the record wrong, and that is a bug to fix

`runners.ts:2471-2480` creates invoices with only `invoiceNo`, `invoiceDate`,
`taxAmount` and `salesOrderId`. It sets **no `status`**, so
`Invoice.status @default(DRAFT)` applies; **no `organizationId`**, so
`assertAuthored` (`invoiceService.ts:328-337`) refuses them; no `customerId`,
`issuedAt` or `total`.

This is worth being explicit about, because it is tempting to treat as a
constraint. It looked like one: "imported invoices are DRAFT, therefore
recognition can never gate on `status = ISSUED`". **That is backwards.** As a
system of record holt should hold the correct record and the importer should
produce it — see Step 0. The shape of the accounting engine must not be bent
around an importer writing incomplete rows.

### What *does* constrain the design

One thing genuinely does: **imported invoices never pass through
`issueInvoice()`** — they are written directly by the importer, and always will
be, because reconstructing history is not the same act as issuing a document.

So recognition cannot live inside `issueInvoice`. **`generateSalesJournal` stays
the single recognition engine**, gated on the invoice — which becomes
trustworthy once Step 0 lands. `issueInvoice`'s AR path is *excluded* for
order-linked invoices rather than extended (Step 2), so the two never both
recognise the same sale.

---

## The work

Each step is independently shippable and verifiable. Ordered so nothing is
briefly broken.

### Step 0 — Make the importer write a correct invoice record

Everything downstream trusts `Invoice`. Today the imported ones are not a record
anything can rely on.

In `runInvoicesImport` (`runners.ts:2468-2482`) set, on both create and update:
`status: "ISSUED"` (an invoice in the report was raised — that is what the row
means), `issuedAt: invoiceDate`, `organizationId: DEFAULT_ORG_ID`,
`customerId` copied from the resolved `salesOrder`, and `total` from the summed
line amounts. Backfill the same fields onto existing imported rows in a
migration.

This is **not** a restatement: it corrects the *record*, not any posted journal.
Historical journals stay exactly as posted (product-owner decision, below).

While here, resolve decision (4): the `FULFILLED` promotion at `:2529-2536` is
correct for reconstruction and wrong as a live rule. Scope it to the import run's
own rows rather than every order in the database with any invoice.

**Verified by:** a coverage assertion that no `Invoice` row has
`organizationId = NULL`, and that every invoice with a `salesOrderId` has a
`customerId`.

### Step 1 — Relieve the deposit *(highest value, no trigger needed)*

The only step that fixes money already on the books.

In `buildJournalLines` (`journalEntry.ts:427-433`), add `priorDepositCredited` to
`SalesOrderForJournal` (`:68-77`). In the `hasInvoices` path, accumulate a
`depositDebits` map keyed on `depositGlId` and emit it alongside the existing
revenue/COGS/tax emits. Memo `Deposit applied - order <orderno>`.

**Amount:** `min(priorDepositCredited, orderTotal)`, where `priorDepositCredited`
is the sum of `Payment.paymentAmount` for the order with `paymentDate < dayStart`
**and** `< earliest Invoice.invoiceDate`, **minus any `DEPOSIT_APPLIED`
`CustomerLedgerEntry` already written for that order**. That last term is what
makes re-generation and instalments idempotent — `processedOrders` is per-call
only, so without it an order paid across three days relieves the deposit three
times.

Write the subledger half in the same transaction: `DEPOSIT_APPLIED` already
exists with its sign convention (`customerLedger.ts:64,290-302`) and
`CustomerLedgerEntry` already carries `salesOrderId` (`schema.prisma:3383`).

**No new GL mapping.** The debit goes to the *same* account the credit came
from — `POS_PAYMENTS`/"On Account", falling back to "Deposit". A second mapping
guarantees the two halves drift apart.

**Verified by:** `depositRecognition.integration.test.ts` goes green as written.

### Step 2 — Stop `issueInvoice` double-crediting order-linked invoices

Small, purely defensive, **must precede step 3**.

`issueInvoice` does not even select `salesOrderId` today. Select it; when
non-null, skip `buildIssuanceJournalLines` + `postJournal` and the `SALE` ledger
entry, and just stamp `status = ISSUED, issuedAt`. Order-linked invoices are
POS-shaped — their cash arrives as `Payment.salesOrderId` and their revenue is
recognised by the daily SJ. Standalone invoices keep the existing AR path
unchanged.

Same guard in `voidInvoice`. Also narrow `journalEntry.ts:787` to
`invoices: { where: { status: { not: "VOID" } } }` — the one status narrowing
that is safe against the DRAFT-import problem.

### Step 3 — Delivery generates the invoice

New `src/lib/billing/invoiceFromDelivery.ts`:

```
invoiceDeliveredOrder(tx, { salesOrderId, serviceAppointmentId, deliveredAt, actor })
  -> { invoiceId: number; created: boolean }
```

Runs inside the caller's transaction; current delivery handlers are bare
`prisma.update` calls and need wrapping.

**Trigger — exactly one primary:** `PUT /api/dispatch/stops/[id]` on the
transition into `COMPLETED`. It is the only event with physical evidence behind
it (signature/photo via `stops/[id]/proof.ts:49-60`). Second entry point:
`PUT /api/service/dispatch/[id]/status` when `appointment.type === "DELIVERY"` —
that handler reads `appointment` and never inspects `.type`; it must.

**Do not** hang it off the status dropdowns — that is recognising revenue from a
`<select>`.

**Precondition the endpoint lacks:** `stops/[id].ts:28` assigns `data.status`
unchecked, so `PENDING → COMPLETED` is accepted with no arrival and no proof.
Import `isValidStopTransition` (`deliveryService.ts:13-27`) and reject invalid
transitions first — otherwise `completedAt` is not a defensible revenue date.

**Idempotency — enforce in the schema, not in code.** Add
`Invoice.serviceAppointmentId Int? @unique`. One delivery event, one invoice; a
doubled `PUT` hits the unique index inside the transaction and returns the
existing invoice. A code-level `findFirst` is not sufficient: the driver UI fires
stop-complete and run-complete as separate calls and retries are routine on a
truck's connection.

**Also write, same transaction:** `OrderLineItem.fulfilledQty` (a dead column
today — zero readers, zero writers) guarded so the running total never exceeds
`orderedQuantity`; an `OrderChangeLog` row; and `consume()`, since a physically
completed delivery currently does not relieve inventory at all.

**Partial delivery — blocked in v1.** Nothing in the data model says which lines
are on a given stop (`ServiceAppointment.lineItemId` exists but
`assignOrderToRun` never sets it). Until step 5, refuse to invoice a partial and
surface why.

### Step 4 — Recognise on the delivery day, not the payment day

`generateSalesJournal`'s only row source is payments (`journalEntry.ts:774-781`)
and it **throws** when a day has none (`:842-844`). So a fully pre-paid order
delivered in July produces no journal at all, and the deposit is never relieved
even after steps 1–3.

Union the payment-driven order set with orders whose order-linked
`Invoice.invoiceDate` falls in the business day, and drop the throw when that
second set is non-empty. Those orders emit revenue/tax/COGS/inventory plus the
step-1 deposit debit, and no cash leg.

### Step 5 — Partial delivery in the recognition path

`buildJournalLines` reads `netPrice`/`cost`/`taxAmount` off the **order** line and
never looks at the invoice (only `id` is selected). To bill partials, scale each
line by `InvoiceLineItem.deliveredQuantity / orderedQuantity` summed over that
order's non-VOID invoices. Only then can step 3's partial guard lift.

### Step 6 — Reconciliation stops calling deferral drift

**Move the source side to a recognised basis; keep bookings as a reported,
non-drifting figure.** Not "add a deferral reconciling item" — `drift` must keep
meaning "the JE disagrees with the operational data". A deferral bucket makes it
mean "disagrees, minus an adjustment we also computed": a second plug sitting
next to Over/Short, which is the shape this file already distrusts
(`dailyReconciliation.ts:145-157`).

- Re-key the source query (`:388-399`) on the recognition event.
- Add a non-drifting `bookings: { revenue, tax, cost }` block carrying the
  current query verbatim, so the operational number survives on screen.
- Add a fifth bucket, `deposits`: journal side = credits − debits on the deposit
  GL (today those lines fall into an explicitly-unsummed bin at `:449-451`);
  source side = COMPLETED payments on un-invoiced orders, minus deposits
  relieved. **This is the one balance that proves the policy is being followed,
  and nothing computes it today.**

Fix two unrelated asymmetries while in here, or they will be blamed on this
change: `status: "COMPLETED"` (`:404`) has no counterpart in the generator's
payment query and `Payment.status` is nullable for imports; and the source sums
`paymentAmount` raw (`:413`) while the generator sign-flips `isRefund`, so every
native refund shows 2× phantom cash drift.

---

## Reports keep bookings — do not "fix" these

None of the following is a bug, and all of it will look like one to a future
reader. `SALES_REVENUE_STATUSES` (`salesOrderRevenue.ts:38`) and
`revenueStatusSql()` (`reports/revenueScope.ts:48-56`) stay order-status-scoped
and `orderDate`-windowed.

Leave alone: `salesDaily`, `monthlyPerformance`, `comparativeSales`, `poSellThru`,
`salespersonDetail`, `salesExplorerQuery`, `salesBySalespersonReport`,
`designerDashboard`, `wealthInsights`, `payPeriodSales`, `detailedSales`,
`grossMargin`, `topSellers`, `factSalesDay`, `buyersReport`, `crossSell`,
`dormantCustomers`, `inventoryHealth`, `returnsAnalysis`, `taxSummary`,
`salesPerformance`, `customersReport`, `customerLeveling`, the dashboard
summary/weekly endpoints, the Mailchimp campaign readers, and the Windfall export.

**Commission likewise** stays on `orderDate` (`commissionSales.ts:44-56,95-115,130`).
`CommissionPlan.countsWhen = DELIVERED` (`schema.prisma:4336`) remains an inert
no-op; moving commission to a delivery basis is a separate decision that also
moves the designer-confirmable Pay Period statement.

Two things in the reporting layer that **should** change, both cheap:

- `taxSummary.ts:53-57` filters `invoiceDate` with no `InvoiceStatus` filter, so
  DRAFT and VOID invoices contribute to a filed tax figure.
- Nothing anywhere labels a figure as bookings vs recognised. The distinction
  currently lives only in a test comment and in this document.

---

## Decisions still owned by the product owner

1. **Historical restatement — decided: not a concern.** Existing journals stay as
   posted. The change applies going forward.
2. **A `FAILED` delivery after invoicing.** `DeliveryStopStatus.FAILED` exists and
   is written by nothing. There is no reversal path anywhere today.
3. **Should the two `FULFILLED` status endpoints keep working as they do**, or
   start refusing to move an order to FULFILLED without a completed stop?
4. **The Ordorite promotion** at `runners.ts:2529-2536` sets invoice ⇒ FULFILLED
   for *every* order in the database carrying any invoice, not just the rows in
   the import run. Correct as a reconstruction rule, too broad as a live one —
   Step 0 scopes it.
5. **Commission on a delivery basis** — currently bookings, deliberately.
