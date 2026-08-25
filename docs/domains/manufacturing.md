# Manufacturing in holt — a feasibility plan

**Status: proposal.** holt is a retail ERP. This document answers a narrower
question than "should we build this": *could* the existing model carry a
made-to-order business, or is the retail shape load-bearing in a way that would
fight it?

The answer is yes, for one specific reason: holt already models *"a thing was
ordered, it is being made somewhere else, it has not arrived, and here is when it
should"*. That is the production-tracking problem. What changes is that
"somewhere else" becomes "here", and one hop becomes several.

Written against a textile and wallpaper manufacturer, because that is the case
that prompted it. See `docs/domains/revenue-recognition.md` for the accounting
half, which is already done.

---

## What already points the right way

| Capability | Where it lives | Why it carries over |
| --- | --- | --- |
| A job raised because a customer ordered something | `PurchaseOrder.salesOrderId` | This IS a work order, addressed to a vendor instead of a work centre |
| "Where is it, is it late" | Delivery Planner, bucketed by `expectedDelivery` | The shop-floor question, already answered for external work |
| Configure-to-order | `SEComponent`, `VendorPriceDimension`, `StyleGradePrice` | The front half of make-to-order, and the part most ERPs do badly |
| Yardage with repeat | `comYardage` / `comYardagePattern` / `comYardageRepeat` | Plain, large-repeat and railroaded are already distinguished |
| Movement between places | `StockLocation` + `InventoryTransfer` | A routing step is a transfer with a sequence |
| Work that is blocked on someone | `ServiceTask.waitingOn` | The shape an approval gate needs |
| Deposits held until shipped | recognition keyed to `deliveredAt` | Exactly the made-to-order accounting problem |
| GL by department | `AccountGroup` — 6 account slots | WIP is a seventh |

## What fights it

Four things, in order of how much they hurt.

1. **`InventoryPosition.quantity` is `Int`**, as is `InventoryTransfer.quantity`.
   Roll goods cannot live in integer positions — you cannot hold 37.5 yards. The
   selling side is already `Decimal` (`OrderLineItem.orderedQuantity`,
   `fulfilledQty`), so the split is invisible until you receive a part roll and
   every count, transfer and allocation rounds.

2. **Nothing carries lot identity.** No lot, batch, dye-lot or serial field
   exists in the 164-model schema. For textiles this is the load-bearing gap:
   two runs of a colourway do not match, so which lot shipped to whom is the
   most consequential fact the business records.

3. **A `StockLocation` is a place, not a stage.** It has `locationType` (a plain
   `String`, so a new value is free) but no sequence — nothing says cut comes
   before print comes before trim.

4. **`PurchaseOrder.vendorId` is non-null.** A work order has no vendor.

---

## The build

Each step is independently shippable and independently verifiable. Steps 1–3 are
small and touch little; 4–5 are the real work; 6–7 are where a manufacturer
starts getting value beyond a whiteboard; 8–9 are optional for a long time.

### Step 1 — Fractional stock

`InventoryPosition.quantity` and `InventoryTransfer.quantity` from `Int` to
`Decimal`. Postgres widens in place, so the migration is two `ALTER COLUMN`s and
no data movement.

The work is not the migration, it is `lib/inventory/allocation.ts`: `allocate`,
`consume`, `release` and `availableQuantity` all do integer arithmetic and
integer comparison. Decimal comparison needs care about precision, and the
existing rounding helper (`round2`) is money-shaped — yardage wants its own.

**Risk:** allocation is money-adjacent. `inventoryAllocation.integration.test.ts`
and `tradingDay.integration.test.ts` are the guard.

### Step 2 — Lot identity

A new `StockLot { id, lotNumber, productId, receivedAt, notes }`, and
`InventoryPosition.stockLotId`. Then three behaviours:

- **Receipt** records the lot (`ReceivingRecord` gains it).
- **Allocation prefers one lot** and records a warning when it cannot satisfy a
  line from a single one. This is the interesting change: `allocate()` currently
  walks free positions in `id` order and takes what it finds.
- **Shipment records which lot went out**, so a reorder can be matched and a
  claim traced to a run.

Purely additive: an order with no lots behaves exactly as today.

### Step 3 — Unit of measure

`Product.unitOfMeasure` (`EACH`, `YARD`, `ROLL`, `SQFT`), displayed on entry and
on every quantity. Mostly presentational once Step 1 has made quantities
fractional. Worth doing early because "3" meaning three yards or three rolls is
the kind of ambiguity that produces a wrong order.

### Step 4 — Work orders

The decision point. Two options:

**(a) Generalise `PurchaseOrder`.** Make `vendorId` nullable, add
`source: VENDOR | INTERNAL`. An internal one is a work order. This reuses the
special-order chain, receiving, and the Delivery Planner **wholesale** — all the
tracking that already works.

**(b) A separate `WorkOrder` model.** Cleaner conceptually; rebuilds the planner,
the receiving path and the linkage to `SalesOrder`.

**Recommend (a)**, with an honest caveat: it overloads a model that currently
means "we bought this". If vendor and internal orders later need to diverge
substantially, that is a split to pay for then. The reuse is worth it now.

### Step 5 — Stages and routing

`StockLocation.locationType` gains `WORK_CENTRE` (free — it is a `String`). Add
`RoutingStep { productId | vendorStyleId, sequence, workCentreId, description }`
and a current-step pointer on the job.

Movement between steps is already `InventoryTransfer`. This step is mostly about
*sequence* — knowing that trim follows print — and about showing a board.

### Step 6 — Bill of materials

`BomLine { parentProductId, componentProductId, quantity, unitOfMeasure }`.

holt's configurator already produces a *specification* (depth, arm, cushion
fill). A BOM turns a specification into materials. Consumption on step
completion — backflushing — reuses `consume()` from Step 1.

### Step 7 — WIP costing

`AccountGroup` gains `wipAccountId`, a seventh slot next to the six it has.

- Issuing material: **Dr WIP, Cr Raw Materials**
- Completing the job: **Dr Finished Goods, Cr WIP**

This plugs directly into the journal engine that now exists — the same engine
that relieves deposits on delivery. Without it, a half-made run is valued either
as raw stock (too low) or as finished goods (too high), and neither balance sheet
is true.

### Step 8 — Approval gates

Strike-offs and cuttings-for-approval hold a job before it runs.
`ServiceTask.waitingOn` is the right shape; what is missing is a gate the job
cannot pass until the approval comes back.

### Step 9 — Capacity

Sequencing jobs to minimise substrate changeovers. Genuinely last: a small
manufacturer runs this on a whiteboard for years, and doing it badly is worse
than not doing it.

---

## What not to build

- **MRP netting and planning.** Large, and the businesses this would serve do not
  have the demand signal to make it meaningful.
- **Labour capture**, unless they actually cost by labour rather than by
  material and a shop rate.
- **Capacity scheduling** before volume makes it hurt (Step 9, and it can wait
  past that).

## Risks worth naming

- Step 1 touches allocation, which touches money. The integration suite exists
  precisely for this; run it per change rather than at the end.
- Lot-aware allocation changes what "available" means. Every report reading
  `availableQuantity` needs checking, not just the allocator.
- Step 4(a) overloads `PurchaseOrder`. Name it clearly in the schema so the next
  reader is not surprised.
