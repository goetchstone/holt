# Manufacturing in holt — a feasibility plan

**Status: proposal.** holt is a retail ERP. This document answers a narrower
question than "should we build this": *could* the existing model carry a
made-to-order business, or is the retail shape load-bearing in a way that would
fight it?

The answer is yes, for one specific reason: holt already models *"a thing was
ordered, it is being made somewhere else, it has not arrived, and here is when it
should"*. That is the production-tracking problem. What changes is that
"somewhere else" becomes "here", and one hop becomes several.

Scoped to **broad-market discrete manufacturing** — someone who buys materials,
makes things from them, and sells them — rather than to one vertical. A textile
and wallpaper maker prompted it and is used for examples, but nothing below is
specific to roll goods except where it says so.

See `docs/domains/revenue-recognition.md` for the accounting half, which is
already done.

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

### Step 2 — Lot identity, and how lots are picked

A new `StockLot { id, lotNumber, productId, receivedAt, notes }`, and
`InventoryPosition.stockLotId`. Then three behaviours:

- **Receipt** records the lot (`ReceivingRecord` gains it).
- **Allocation prefers one lot** and records a warning when it cannot satisfy a
  line from a single one. This is the interesting change: `allocate()` currently
  walks free positions in `id` order and takes what it finds.
- **Shipment records which lot went out**, so a reorder can be matched and a
  claim traced to a run.

A **removal strategy** comes with it, per location: FIFO by default, FEFO where
things expire. Once lots exist, "which one do we pick" needs an answer, and
newest-first silently ages the oldest stock into scrap.

Purely additive: an order with no lots behaves exactly as today.

### Step 3 — Unit of measure, with conversion

Not just a label. `UomCategory` (Length, Weight, Count, Area) and `Uom` with a
factor against the category's reference unit, then `Product.uomId` and a
purchase UoM that may differ from the stock UoM.

The label alone is the tempting version and it is not enough: buying in boxes of
twelve, holding in each and selling by the yard is ordinary, and without
conversion every purchase order needs mental arithmetic that somebody
eventually gets wrong. Odoo models this well and it is worth copying.

### Step 4 — Work orders, with partial completion

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

Either way the job must support **partial completion**: an order for 100 that
finishes 60 today leaves 40 open, not the whole thing. `ReceivingRecord` already
does exactly this shape for vendor orders, which is another argument for (a).

Option (a) also gives **subcontracting** almost for free, and subcontracting is
often most of a small manufacturer's production. A subcontracted job is a supply
order that *has* a vendor and *also* has a routing — materials go out, a
finished component comes back.

### Step 5 — Stages and routing

`StockLocation.locationType` gains `WORK_CENTRE` (free — it is a `String`). Add
`RoutingStep { productId | vendorStyleId, sequence, workCentreId, description }`
and a current-step pointer on the job.

Movement between steps is already `InventoryTransfer`. This step is mostly about
*sequence* — knowing that trim follows print — and about showing a board.

### Step 6 — Bill of materials

`Bom { productId, quantity, version }` and
`BomLine { bomId, componentProductId, quantity, uomId, scrapPercent }`.

**Multi-level**, not flat: a component may itself have a BoM, and explosion
recurses. A flat list handles a cushion and not a sofa made of a frame made of
rails.

**`scrapPercent` from the start.** Cutting loses material and printing loses a
metre to setup. If the BoM says 10 and the floor consumes 11, every job costs
wrong, and adding yield later means restating history.

holt's configurator already produces a *specification* (depth, arm, cushion
fill). A BoM turns a specification into materials. Consumption on step
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

## What Odoo gives that this plan does not

The honest answer to "does this cover everything Odoo does" is **no, and not
close** — Odoo's manufacturing apps are a decade of work with a large installed
base driving the edges. What follows is the gap, grouped by whether a small or
mid-sized manufacturer would actually feel it.

### Tier 1 — you cannot run a factory without these

Four are in the plan above (BoM, work orders, routing, WIP). These are the ones
that are **not**, and they belong in it:

| Missing | Why it bites |
| --- | --- |
| **UoM conversion**, not just a label | Buy in boxes of 12, hold in each, sell by the yard. The plan had UoM as a display field; Odoo has unit *categories* with conversion factors, and without them every purchase needs mental arithmetic. |
| **Multi-level BoM** | An assembly made of assemblies. The plan's `BomLine` is flat, which handles a cushion but not a sofa made of a frame made of rails. |
| **Scrap and expected yield** | Cutting loses material; printing loses a metre to setup. If the BoM says 10 and the floor uses 11, cost is wrong on every job. Textiles feel this hardest, but every process has it. |
| **Partial completion / backorders** | A job for 100 finishes 60 today. Without it the whole order is open or closed, and neither is true. |
| **Removal strategy** (FIFO / FEFO) | Once lots exist, "which lot do we pick" needs a rule. Odoo makes it configurable per location. Picking newest-first silently ages your oldest stock into scrap. |

### Tier 2 — you will want these inside a year

| Missing | Why |
| --- | --- |
| **Subcontracting** | Send materials out, get a finished component back. Odoo treats it as a first-class route. For a small manufacturer this is often *most* of production — the printer, the plater, the CNC shop. |
| **Reordering rules** | Min/max per product per location, generating POs automatically. holt has no `reorderPoint` at all. |
| **Landed costs** | Freight and duty allocated into inventory value. Anyone importing materials is understating cost of goods without it. |
| **Costing method** | Standard vs average vs FIFO. holt has one `baseCost` field and no method — fine for retail where you buy and sell the same thing, wrong once you make it. |
| **Quality control points** | An inspection with recorded measurements at a named step. The plan's approval gates are a subset — they hold a job, they do not record what was measured. |
| **Kit / phantom BoMs** | Sell an assembly, ship and pick its components. |
| **By-products and co-products** | One run yields two sellable things. Common in cutting and in food. |
| **Traceability reports** | Not the lot field — the *reports*. "Where did lot 240817-B go" downstream, and "what went into this unit" upstream. This is the thing a recall or a claim actually needs. |

### Tier 3 — Odoo has them and most sites never switch them on

Master production schedule, capacity planning with OEE, equipment maintenance,
PLM with engineering change orders, unbuild/disassembly, analytic accounting,
and multi-step warehouse routes with push/pull rules. Real features, genuinely
used at scale, and a distraction for anyone below it.

### Outside manufacturing entirely

Odoo is a suite, and its breadth is the other half of the comparison. holt has
no multi-currency, no multi-company or intercompany, no payroll, no fixed assets
or depreciation, no budgeting, no bank statement import and reconciliation, no
expenses, no purchase RFQ or vendor bidding, no dropshipping, and no document
OCR. Several of those matter long before manufacturing does.

## The realistic read

Reaching Odoo's manufacturing is not a project, it is a product line. What is
reachable is the subset a small manufacturer runs on: **UoM with conversion,
lots with FIFO/FEFO picking, multi-level BoMs with scrap, work orders with
routing and partial completion, subcontracting, and WIP costing.** That is a
serious piece of work and it is finite — and it sits on top of a customer,
catalogue, pricing, inventory and general-ledger layer that already exists,
which is the part usually underestimated.

Where holt would keep an advantage is the front of the business: configure-to-
order pricing with grades and options, to-the-trade tiers, deposit-to-delivery
recognition, and commission that can count on either basis. Odoo does those
adequately; holt was built for them.

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
