# Pricing & Catalog

Vendor price list import from PDF/CSV/XLSX. Multi-dimensional pricing engine. Product catalog management.

**Before working on any vendor parser, read `docs/domains/vendors/common.md` first.** It covers shared patterns: VendorStyle vs Product, grade systems, option seeding, server-only constraints.

## Pricing models

The `VendorPricingModel` enum determines which pricing path the configurator follows. **Adding a new vendor requires choosing the correct model** — picking the wrong one cascades into broken price math the configurator can't recover from without re-import.

| Model                | When to use                                                                 | Example                               |
| -------------------- | --------------------------------------------------------------------------- | ------------------------------------- |
| `FLAT`               | Single price per product, no axes                                           | Most accessory vendors                |
| `GRADE_BASED`        | Fabric/leather grade matrix (e.g. grades 14–60 for fabric, C–Z for leather) | Wesley Hall, CR Laine                 |
| `FRAME_PLUS_CUSHION` | Frame + separately-priced cushion fill                                      | Kingsley Bate                         |
| `SPECIES_MATRIX`     | Wood species drives base price                                              | Gat Creek                             |
| `MULTI_AXIS`         | 2–3 pricing dimensions combine (frame × grade × finish)                     | American Leather (frame + dual grade) |
| `AREA_BASED`         | Price per sq ft / sq yard                                                   | Rug vendors (not currently active)    |
| `SIZE_BASED`         | Size class drives price (sofa < loveseat < sectional)                       | Some Wesley Hall SE configurations    |

## Tax group on categories and products

`Category.taxGroupId` is the tax group a category's products sell under, and
`Product.taxGroupId` overrides it for one product; null on both means the district's
rules, as before. The category editor and the product edit form choose them. A group
can be marked "Not taxed" in Admin → Tax (0% in every district). How the group picks
a line's rate is in `docs/domains/accounting.md` under "A line sells under a tax group"
(GAP-04b, 2026-10-29).

## VendorStyle vs Product

Both are created during import. VendorStyles are catalog templates ("frames" from a vendor price list); Products are materialized physical items.

- **VendorStyle** — what's in the catalog. Configurable. Lives in `VendorStyle` + `StyleGradePrice` + `StyleAxisPrice` etc.
- **Product** — what you can buy or stock. Linked to a VendorStyle via `vendorStyleId` when materialized from a configurator.

**There is no unique constraint on `(productNumber, vendorId)`.** `Product`'s only
unique key is `externalId` (`schema.prisma`, model `Product`). The product importers
(`import-basic.ts`, the generic product import in `lib/genericImportRunner.ts`) find an
existing product with `findFirst({ productNumber, vendorId })` and update it, or create
one; two rows with the same pair are possible, and the importer updates the first it
finds. Re-importing a price list updates VendorStyle pricing but does not blow away
product history. (Corrected 2026-11-14: this line used to claim a unique constraint.)

**Product search** (`GET /api/products`, SEC-13 2026-09-24) serves seven screens: All Products, Create Variant, New Quote, Detailed Sales' "Edit line item", POS, Reconcile Photos and New Transfer. It takes `{ anyOf }` of their keys (`catalog.read`, `catalog.write`, `sales.write`, `pos.operate`, `inventory.count`, `inventory.transfer`), so granting a role any of those screens in Roles also grants the search. It returns product scalars plus vendor/department/category/type **names**: never the vendor row (account number, discounts, markup, terms, contacts), staff emails or the wholesale price-list inputs. `baseCost` still goes to every admitted role; a separate "View cost" switch is SEC-14.

## Retail is changed in one place

GAP-06 part A, 2026-11-14, DECISIONS 58. A stocked product's selling price is
`Product.baseRetail`, with `Product.wasPrice` the sale tag's "was" price. Both are
stored, never derived, and the register charges `baseRetail`.

**The one writer.** Every path that changes an EXISTING product's `baseRetail` or
`wasPrice` goes through `lib/pricing/retailWriter.ts` (rule 42):

| Entry point                                                                                                                       | Used by                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `applyRetailChanges(tx, changes, { source, actor, honourLock, audit })`                                                           | `PATCH /api/products/[id]` (honourLock false: a person editing one product), the mass price change, the vendor style edit (`pricing/styles/[id]`)            |
| `lockRetailRows` / `lockRetailRow` + `retailFieldsForImport(existing, incoming, { mayChangePrice })` + `recordImportPriceChanges` | `import-basic.ts`, the generic product import, the legacy POS stock-by-item feed and item export (`adapters/legacyPos/runners.ts`), both consignment imports |
| `setPriceLocks(tx, ids, locked, ...)`                                                                                             | the product's lock toggle, the mass change's Lock / Unlock                                                                                                   |

`applyRetailChanges` locks the rows `FOR UPDATE` in id order, then reports each
product as changed, unchanged, locked (kept), stale (its price moved since the caller
looked) or missing. It refuses a price that isn't to the cent, and a was price of 0,
naming the product -- but only a price that moves: a target equal to the stored value
is the caller sending it back, so a retail stored past the cent (old imports wrote
`cost × markup` unrounded; `Product.baseRetail` is unbounded) doesn't refuse a run
that only changes the was price.

**Tripwire.** `__tests__/retailWriters.test.ts` counts the places each file under
`src/` writes `baseRetail` and compares them with `__tests__/fixtures/retail-writers.txt`,
which classifies every such file as `writer` (goes through the writer) or
`create-only: <reason>` (only ever creates products). It fails both ways: an unlisted
file that writes retail, and a listed file that no longer does. It counts keys
(`baseRetail:`, quoted or computed), shorthand (`{ baseRetail }` and `{ name,
baseRetail }` on one line included) and assignments (`x.baseRetail =`,
`x["baseRetail"] =`); its own tests hold each form.

**Price lock.** `Product.priceLocked` (NOT NULL, default false). A locked price is kept
by imports, mass price changes and style edits; a person editing that product on its
page still changes it, and the page and edit form say it is locked. Locking needs
`catalog.pricing` and is audited as `PRICE_LOCK_CHANGED`.

**Importers.** For an existing product, a blank, zero or unreadable retail cell keeps
the product's own price (writing 0 made it unsellable: `catalogRetailPrice` in
`lib/pos/cartPricing.ts` treats 0 as no price), and a locked product keeps its price.
Each importer decides from the product's row read `FOR UPDATE` (`lockRetailRows`)
inside the transaction that writes it -- never from a read taken before that
transaction, or once for the whole run -- so a price locked, or changed by a mass
change, while an import runs is kept, and the ledger's "from" is the price actually
replaced. The stock-by-item feed locks each batch's known products in one read at the
batch's start; the item export locks each chunk's in its update transaction.
`import-basic.ts` and both consignment imports also ask for `catalog.pricing` (gate
`also`); without it an existing product keeps its price and the import counts it.
Each importer reports `priceLockedKept`, `priceBlankKept` and `priceNoPermissionKept`;
the generic import adds them, and a note, only when non-zero, so its result is
otherwise unchanged. New products are created as before.

**The ledger.** `ProductPriceChange`: product, retail and was price from and to,
`source` (from the one list in `lib/pricing/priceChangeSources.ts`: MANUAL,
MASS_CHANGE, IMPORT, LEGACY_FEED, CONSIGNMENT_IMPORT, STYLE_EDIT), the mass change's
`batchId`, a note, the actor and the time. One row per changed product, in the same
transaction as the change. A trigger refuses UPDATE and DELETE (copied into
`prisma/testing/db-guards.sql`). There is no undo: a reversal is another change. The
product page lists the latest 50, newest first (`GET /api/products/[id]` →
`priceHistory`).

**Permissions on a product's price** (`PATCH /api/products/[id]`): changing retail or
the lock needs `catalog.pricing`, checked only when the value actually moves (the edit
form resends every field); the was price stays on `catalog.write` (tag workflow,
DECISIONS 43). Every built-in role holding `catalog.write` also holds
`catalog.pricing` (`permissionCatalog.ts`), so the split only bites a store's own
roles.

**Mass price change.** Inventory → Mass Price Change
(`app/(dashboard)/app/inventory/mass-price-change/`), gated `catalog.pricing`, routes
under `pages/api/pricing/mass-change/` (`index` list, `options` for the filters,
`preview`, `apply`, `lock`), contract in `lib/pricing/massChangeShared.ts`, server
side in `lib/pricing/massChange.ts`.

- Filter by vendor, department, category, text and lock; active products only. Pick
  rows (kept across pages) or "all matching the filter", which the server resolves
  again. More than 2,000 products is refused with a 400, never done in part.
- Retail: cost × resolved markup (skipped, with the reason, when there's no cost or no
  markup), ± a percent, or set to an amount; was price: keep, today's retail (a
  markdown), or clear. Rounding is the store's rule unless the run picks another; an
  amount typed is not rounded. A computed price that rounds to 0 (40 cents to the
  nearest dollar) is skipped `ROUNDS_TO_ZERO`, never written. A row whose was price
  would not be above its new retail (a price going up with FROM_CURRENT or KEEP, or
  KEEP + FROM_CURRENT) is skipped `WAS_NOT_ABOVE`, because a sale tag refuses it
  (`lib/labels/productTag.ts`); apply refuses such a row too (`wasAboveRetail` in
  `massChangeShared.ts`).
- Cost × markup needs "View cost" as well: preview answers 403 for it without
  `catalog.cost` (its prices are cost × a markup the caller can see), and the screen
  doesn't offer it. The other operations stay open to `catalog.pricing`.
- Preview returns each row before and after with a skip reason (`MASS_CHANGE_SKIPS`).
  Apply sends the previewed rows back; in ONE transaction the server refuses as stale
  any row whose price moved since, keeps locked ones, writes the rest under a new
  `batchId` with source MASS_CHANGE, and records one `PRICES_ADJUSTED` entry.
- The list strips cost for a caller without "View cost" (`catalog.cost`, SEC-14) and
  says `costVisible`.

**Markup.** A markup is a multiplier (2.2 = cost × 2.2). `lib/pricing/markup.ts`
`resolveMarkup` picks among the vendor's (`Vendor.defaultMarkup`), the category's
(`Category.defaultMarkup`, Decimal(8,4), CHECK NULL or > 0) and the store's
(`AppSettings.pricing.defaultMarkup`), in the order `AppSettings.pricing.markupPrecedence`
says: `VENDOR_FIRST` (default, keeps every price a vendor markup gives today) or
`CATEGORY_FIRST`. The store's is the fallback either way. 0, negative or unreadable
counts as unset; with none, the catalog shows cost and invents no retail.

- `GET /api/pricing/products` returns each style's own `markup` and `markupSource`
  (a style's nullable `categoryId` falls back to vendor and store), and the three
  configurators (`PriceConfigurator`, `SEConfigurator`, `WoodPriceConfigurator`) price
  from the chosen style's markup and name its source in "Suggested Retail". The
  vendor-level `defaultMarkup` (resolved) and `pricingStatus` stay for older clients;
  `ownMarkup` is the vendor's own, which Admin → Vendor Pricing → Price Configurator's
  vendor settings edit. Before 2026-11-14 that editor was filled from the resolved
  markup, so saving a vendor's discount copied the store's markup onto the vendor.
- `import-basic.ts`'s auto markup is a multiplier through `resolveMarkup` (it treated
  the markup as a percent: a $100 item at 2.2 priced at $102.20).
- Vendor markup (`PATCH /api/vendors/[id]`, `catalog.pricing`) is validated in
  `lib/vendorPatch.ts` (finite > 0 or null). Category markup is set in Inventory →
  Categories (PUT "only when sent", so other editors of a category don't clear it;
  POST accepts one too); changing either needs `catalog.pricing`. Each change is
  audited `MARKUP_CHANGED` in its transaction.

**Rounding.** `lib/pricing/rounding.ts` `roundRetail(value, rule)`, worked in exact
cents (half up), refusing negatives. Rules: `CENTS` (default, invents nothing),
`WHOLE_UP`, `WHOLE_NEAREST`, `END_99`, `END_95`. The .99 / .95 rules round to the
nearest whole dollar and take 1 or 5 cents off, so the left digit drops: 100.00 becomes
99.99, 101.40 becomes 100.99 (owner, 2026-11-14). A price that rounds to no dollar stays
$0, which the mass change skips. Applied to computed prices
only: an import's auto markup and the mass change's markup and percent runs.

**Store settings.** Admin → Settings → Pricing writes `AppSettings.pricing`
(`defaultMarkup`, `markupPrecedence`, `retailRounding`, and since part C
`tradeDiscountOnSaleItems`) through
`PUT /api/admin/settings`. What is sent is merged over what is stored; a save that
changes nothing writes nothing; `SETTINGS_SAVED` names the keys that moved
(`pricing.retailRounding`). `parsePricingConfig` reads it fail-closed.

**Left open** (ROADMAP GAP-06):

- Scheduled sale prices, re-pricing open orders,
  `ProductVariant.retail`, and server-side re-pricing of a configured line.
- The imports gated on `admin.data` ("Destructive data operations") -- the generic
  product import and the legacy POS feed and item export -- change an existing
  product's retail without checking `catalog.pricing`; the lock and ledger apply.
- `import-basic.ts`, the generic import and the legacy feed still create a NEW
  product with the file's retail unrounded, so retail past the cent keeps arriving.
- Nothing scans for raw `wasPrice` writes the way the tripwire does for `baseRetail`
  (none exists outside the writer today).
- A product created by the item export or quick-create with no price still gets
  retail 0, not none.
- The consignment imports compute their own retail (a fixed multiple of cost) and name
  their department and category in code: deployment facts (rule 61).
- The vendor-level `pricingStatus` says `UNCONFIGURED_MARKUP` when only categories
  carry markups, though styles in those categories price.

## Trade tier pricing

GAP-06 part C, 2026-11-14, DECISIONS 61. A manager gives a customer a trade tier
(`TradeTier`: a name and a `discountPercent`); on each eligible line of that
customer's sales the price is the item's retail less the tier's percent.

**The arithmetic, one home.** `lib/pricing/tradeTier.ts`, pure and client-safe:

- `entitledUnitPrice({ effectiveRetail, onSale, tier, vendorAllows, settings })`
  returns `{ price, tierPercent, reason }`. Rounded to the cent (`toCents`), never by
  the store's retail rounding: it is a discount, not a new retail. Reasons:
  `ENTITLED`, `NO_TIER`, `TIER_INACTIVE`, `TIER_NO_DISCOUNT`, `VENDOR_OPTED_OUT`,
  `ON_SALE`, `NO_PRICE`.
- `customerTradeTier(tier)` is the tier as the screens get it: only an active one with
  a percent above 0 and at most 100, as numbers. `isTradeAccount` alone grants nothing.
- `priceLineForTier(line, tier)` prices a register or New Quote line: a line whose
  price someone typed keeps it, a return or an ineligible product sells at its
  retail, anything else at the entitled price, with `tradePercent` for the
  "Trade 20%" note.

**Which products take a tier.** `lib/pricing/tradeEligibility.ts`
`tradeEligibleProducts`: the vendor's `allowTradeDiscount` is true, the product is not
`madeToOrder` (a configured or custom line's one-off product, priced by hand), and its
category isn't one a `PROTECTION_PLAN` commission plan names. Gift cards, delivery fees
and returns are never priced by a tier. `GET /api/products` and
`/api/products/find-by-identifier` return `tradeEligible` for each product, so the
screens agree with the server.

**Sale items.** `AppSettings.pricing.tradeDiscountOnSaleItems`, false by default (the
strictest): an item on sale sells at its sale price with nothing more off. True: the
tier comes off the sale price. `parsePricingConfig` reads it true only when stored as
exactly `true`. Until scheduled sale prices (part B) land nothing is on sale:
`catalogRetailFor` in `lib/sales/discountApproval.ts` is the seam, returning
`{ price, onSale: false }`.

**The discount policy.** `lib/sales/discountApproval.ts`. A tier is an entitlement a
manager set, not a cashier's discount:

- `LinePolicy { listUnit, baselineUnit, trade }`. `listUnit` stays the retail and is
  what `OrderLineItem.listPrice` records, so the order screen and receipts show the
  whole saving. `baselineUnit` is the entitled price, and a discount is measured from
  it: a sale at the trade price needs no manager's PIN; anything below it is a
  discount like any other.
- `catalogLinePolicies(db, lines, { customerId })` builds it for create-from-cart,
  add-line (`orders/[id]/line-items.ts`), replace-line (`line-items/[lineItemId].ts`)
  and `duplicateOrder` (today's prices under the customer's tier today). A configured
  or custom cart line has no product to price, so it takes its own price.
- A price edit on an existing line measures from `currentLinePolicies`: what the line
  recorded (`existingLinePolicy`), or what the order's customer's tier makes of the
  list price it recorded, whichever is lower. Raising the price above the entitled
  price clears the line's tier; bringing it back down to the entitled price is no
  discount and records the tier again (a customer whose tier has since gone keeps
  only what the line recorded).
- `catalogListUnits` (no customer, no tier) is kept for scheduled sales' house-call
  booking (part B), which then prices with no tier.

**Recorded on the line.** `OrderLineItem.tradeTierId` (FK, `ON DELETE SET NULL`;
tiers are only deactivated) and `tradeDiscountPercent Decimal(5,2)`, CHECK
`OrderLineItem_tradeDiscountPercent_range` (null, or above 0 and at most 100; also in
`prisma/testing/db-guards.sql`). `tradeTierPercent` rounds a tier's percent to the
hundredth before it prices anything, so the price a line sells for and the percent it
records are the same number (a 33.333% tier saved before the routes refused it prices
and records 33.33), and a percent that rounds to 0 takes nothing off. `recordedTrade` writes them only on a line sold, not
returned, at or below its entitled price. A client that sends retail for a trade
customer is charged retail and no tier is recorded: the server judges the price, it
doesn't set it, so the screens send the entitled `unitPrice`.

**The screens.** `GET /api/customers` returns `tradeTier { id, name, discountPercent }`
(null unless active); `useCustomerSearch` carries it. The register (`PosView`) and New
Quote keep each line's `retail`, `tradeEligible`, `priceTyped` and `tradePercent`;
picking, changing or removing the customer re-prices every untyped line through
`priceLineForTier`, so taking the customer off restores retail. A typed price sets
`priceTyped`. The order screen shows "Trade N%" beside a line's saving.

**A quote changing hands.** `PUT /api/sales/orders/[id]` with a new `customerId` on a
quote with no payment (a pending one included) runs `repriceQuoteTrade`
(`lib/sales/quoteTradePricing.ts`) and then `rerateQuoteTax`. Only lines still at the
price they were written at (their list, or the trade price they recorded) are
re-priced; a typed or discounted line keeps its price. Each re-priced line keeps its
`listPrice` and gets a PRICE_CHANGE history entry. The response carries
`repricing { repriced, kept, message }`, which the order screen shows.

A kept line is still judged for its new customer (`planQuoteTrade`, before the
transaction so a wrong PIN counts). Its discount was measured from the old customer's
price (`currentLinePolicies` under the old customer: what it recorded, or that
customer's tier on its list price, whichever is lower). Where the new customer's price
is higher -- a trade quote handed to a walk-in -- its discount from the new price goes
through `authorizeDiscount`: a caller holding `sales.discount` or within the store's
limit passes, anyone else needs a manager's PIN (`DISCOUNT_APPROVAL_REQUIRED`, which
the order screen's customer link asks for), and an approval is logged per line. Every
line, kept or re-priced, then records the new customer's tier or none, never the old
one's. Nothing records which customer a typed price was set for, so a walk-in's typed
discount on a quote handed to a trade customer and back is asked for again: the
strict side of not knowing.

**Giving a tier.** `lib/customers/tradeTierAssignment.ts` `setCustomerTradeTier` is
the one writer of `Customer.tradeTierId`, used by `PUT /api/customers/[id]/trade` (one
transaction) and the demo seed. It refuses a tier that's turned off, and records
`TRADE_TIER_ASSIGNED`. Saving a customer with the tier they already have is no change,
even a tier turned off since. The route stays on the MANAGER/ADMIN role array: no
permission covers both a standing discount and a tax exemption.

**Making and changing a tier.** `/api/admin/trade-tiers` (gate `catalog.pricing`)
takes a percent from 0 to 100 to the hundredth (`tierPercentProblem`, which the Trade
Tiers screen also runs). Making a tier, changing its percent or turning it back on
gives a standing discount, so it also needs `sales.discount`; a rename, a sort order or
turning a tier off takes the gate alone. Making one, a new percent, and turning it on
or off are audited `TRADE_TIER_CHANGED` in the save's transaction (and the routes are
in `__tests__/auditCoverage.test.ts`'s sensitive shapes).

**Vendors.** The vendor screen (Inventory → Vendors, the vendor's details) edits
"Trade discounts apply" (`Vendor.allowTradeDiscount`, default true) through
`PATCH /api/vendors/[id]` (`catalog.pricing`), audited `VENDOR_TRADE_DISCOUNT_CHANGED`
in its transaction.

**Tests.** `__tests__/tradeTier.test.ts` (the helper, `priceLineForTier`),
`__tests__/integration/tradeTierPricing.integration.test.ts` (every writer, the
quote re-price, the route, the vendor audit and the setting, against the real
database).

**Left open:** a tier on proposals' typed B2B prices, per-category tier exclusions, a
tier on configured lines, carrying a tier through a customer merge, billing invoices
(the tRPC billing router), and part B's house-call booking (`catalogListUnits`, no
tier).
A quote changing hands reads whether an item is on sale today, not when it was written.
Once part B lands, the product lookups need a sale flag, or `tradeEligible` folding in
"on sale and the store says no", for the screens to match the server on a sale item.

## Grade auto-extension

During import, grade tiers are auto-extended:

- Fabric: up to **grade 60**
- Leather: up to **letter Z**

Extension uses the riser pattern from the highest-defined tier (e.g., if grade 25 is +$200 over 14, grade 26 is +$200 over 25, etc.). Lets the configurator handle in-house grade additions without re-importing the vendor's whole book.

## Server-only modules

`pdf-parse` uses Node's `fs` and **cannot be imported (even dynamically) from files that are also pulled into client bundles.** If a parser needs `pdf-parse`, it must live in a separate file imported only by API routes.

Examples:

- `wesleyHallParser.ts` IS imported by the client-side import page → must NOT use pdf-parse → SE parser lives in `seParser.ts` instead
- `crLaineExtractor.ts`, `hdProposalParser.ts` — only imported by API routes → can use pdf-parse freely
- `pdfTableExtractor.ts`, `pdfImageExtractor.ts` — server-only, used by multiple parsers

If you add a new parser:

1. Decide: client-importable or server-only?
2. If server-only: name it `*Extractor.ts` (codebase convention) and don't import it from any page
3. If client-importable: split out any pdf-parse usage into a sibling `*Parser.ts` file

## Synthetic SE-* VendorStyles (Wesley Hall)

Wesley Hall's Signature Elements (build-your-own) system uses synthetic VendorStyles with style numbers like `SE-F21-XLS` (Fabric, Standard Depth, XL Sofa). The SE import transposes column-oriented PDF pricing tables into row-oriented product records.

Component selections (base, arm, back) affect the assembled SKU label but not the base price. See `docs/domains/vendors/wesley-hall.md` for the full SE configurator + component catalog.

## Configurator modes

When Wesley Hall is selected AND SE-* products exist, both the admin (`/admin/pricing/configurator`) and designer (`/tools/configurator`) configurator pages show a Standard / Signature Elements toggle. The designer version passes `retailOnly` to hide wholesale costs.

## HD Proposal import path

Hunter Douglas proposals come as PDFs from the HD Direct Connect portal, not as a standard price list import. Parser: `lib/pricing/hdProposalParser.ts`. Endpoint: `pages/api/sales/import-hd-proposal.ts`.

Behavior:

- Extracts quote number, customer info, line items with MSRP, per-line freight + installation
- Creates or overwrites a SalesOrder with orderno `HD-{quoteNumber}` (supports customer revisions via re-import)
- Freight costs summed into an `HD-FREIGHT` line item
- Installation costs summed into a `LABOR-HD` line item

Import page at `/sales/import-hd`, nav card on the Sales hub.

## Any vendor's book, and the demo's mock vendors

**A vendor with no parser of its own** imports through the standard price-book
layout. The format is described in vendors-wholesale.md, "A book can declare its
grades too".

**A flat catalog** goes through Data Import's product entity (`lib/genericImport.ts`):

- SKU, name, vendor, department, category, cost, retail and description;
- since 2026-10-29, `Case Pack` (`Product.cartonQty`), which is written only when
  the cell holds a whole count of 1 or more.

**The demo carries five invented vendors** (`prisma/seed/demo/priceBooks.ts`, books
in `prisma/seed/demo/pricebooks/`). Every name, style and price is made up, and a
client's real price book is never committed.

- **Three special-order lines in the standard layout:**
  - a recliner maker, priced by leather grade × base option;
  - a leather upholsterer, by leather grade, with a sleeper option;
  - a custom upholstery house: COM plus fabric grades, yardage, a grade riser,
    and nailhead / skirt / finish options.
- **Two flat lines:** lighting with finish variants, and mirrors and decor with
  case packs.

**Markup.** Retail on the special-order lines comes from each vendor's
`defaultMarkup` (2.0 / 2.2 / 2.4), and the store-wide
`AppSettings.pricing.defaultMarkup` is 2.2. These are demo assumptions, not
facts. Any vendor a visitor imports through the standard layout prices straight
away from the store-wide default.

## Vendor Runbooks

| Vendor           | Pricing Model         | Runbook                                            | Parser                               |
| ---------------- | --------------------- | -------------------------------------------------- | ------------------------------------ |
| Wesley Hall      | Grade-based + SE      | [wesley-hall.md](vendors/wesley-hall.md)           | `wesleyHallParser.ts`, `seParser.ts` |
| CR Laine         | Grade-based           | [cr-laine.md](vendors/cr-laine.md)                 | `crLaineExtractor.ts`                |
| American Leather | Dual grade            | [american-leather.md](vendors/american-leather.md) | `dualGradeExtractor.ts`              |
| Ekornes          | MRP-based             | [ekornes.md](vendors/ekornes.md)                   | `ekornesParser.ts`                   |
| Kingsley Bate    | Frame + Cushion       | [kingsley-bate.md](vendors/kingsley-bate.md)       | `kingsleyBateParser.ts`              |
| Brown Jordan     | Retail grade          | [brown-jordan.md](vendors/brown-jordan.md)         | `brownJordanParser.ts`               |
| Gat Creek        | Species matrix        | [gat-creek.md](vendors/gat-creek.md)               | `gatCreekExtractor.ts`               |
| Jensen Leisure   | Retail grade          | [jensen-leisure.md](vendors/jensen-leisure.md)     | `jensenLeisureParser.ts`             |
| Summer Classics  | Wholesale grade       | [summer-classics.md](vendors/summer-classics.md)   | `summerClassicsParser.ts`            |
| Hunter Douglas   | Line-item (proposals) | [hunter-douglas.md](vendors/hunter-douglas.md)     | `hdProposalParser.ts`                |

## Adding a New Vendor

1. Determine the pricing model (see `common.md` for model descriptions)
2. Create a parser in `lib/pricing/{vendorName}Parser.ts`
3. Create or reuse an import endpoint in `pages/api/pricing/import/`
4. Add vendor name aliases to `resolveVendorKey()` and `productEntryMapping.ts`
5. Create a vendor runbook in `docs/domains/vendors/{vendor}.md`
6. If the parser uses `pdf-parse`, ensure it is NOT imported from client-side code
7. Key every lookup built from upload or request text (tier codes, collection
   names, program types) with a `Map`, never `{}`: a plain object drops a key
   named `__proto__`, and reads `constructor` / `toString` back as functions,
   which pass an `if (!tierId)` check and fail later in Prisma. Upsert
   collections with `upsertCollectionIds()` (`lib/pricing/upsertCollectionIds.ts`).
   Regexes over uploaded text use bounded runs (`{1,200}`, not `+`) where a
   run is followed by a literal, as `extractCushionOptions()` does: an
   unbounded run is quadratic on a long line with no match (CodeQL
   js/polynomial-redos; 2026-10-15)

## Verification Checklist

- [ ] `npm test -- wesleyHallParser priceCalculator pricingUtils` passes
- [ ] New parsers using `pdf-parse` are in separate files, not imported client-side
- [ ] Import creates both VendorStyle and Product in a transaction
- [ ] Grade tiers auto-extend correctly (60 for fabric, Z for leather)
- [ ] Option seeds use upsert to preserve manual edits
- [ ] Vendor added to `productEntryMapping.ts` for POS matching
- [ ] Vendor runbook created or updated
- [ ] Lookups keyed by upload text are `Map`s (step 7)

## Test Coverage

Well covered: `wesleyHallParser.test.ts` (389 lines), `priceCalculator.test.ts`, `pricingUtils.test.ts`

Gap: no source-text tripwire ensuring that any new `pdf-parse`-using file isn't imported from a page. The constraint is enforced today only by failed Next.js builds when violated.

---

Last verified: 2026-05-20; "Retail is changed in one place" and the unique-constraint correction 2026-11-14 against source.
