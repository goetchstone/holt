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

**The route pages and has no `all`.** A picker searches it as you type
(`hooks/useProductSearch`), never asks `?all=true`: Create Variant's
master-product picker once did and offered the first 10 products. Every
`"/api/...?all=true"` request in `src/` must reach a route that reads
`query.all`, or `__tests__/allListRequestTripwire.test.ts` fails. A picker says
"No matching ..." only when the hook's `status` is `done`, meaning the held
results answer exactly what is typed (`lib/searchAsYouTypeStatus.ts`). During the
debounce window `isSearching` is still false and the results are the previous
query's.

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

- Re-pricing open quotes and orders (also when a sale starts or ends: lines keep the
  price they were added at; a quote changing hands is re-priced for its new customer's
  tier, "Trade tier pricing"),
  `ProductVariant.retail`, and server-side re-pricing of a configured line.
- Scheduled sales are store-wide: no per-store sale. A configured or custom line gets
  no sale price.
- An optional automation that sends or prints the morning's tags to change would be a
  store setting (on/off, when, who), not a fixed job.
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

## Scheduled sale prices

GAP-06 part B, DECISIONS 60. Source read 2026-11-14: `lib/pricing/salePrice.ts`,
`lib/pricing/sales.ts`, `lib/pricing/salesShared.ts`, `pages/api/pricing/sales/*`,
`app/(dashboard)/app/inventory/sales/*`, `components/pricing/ProductPicker.tsx`,
`lib/labels/productTag.ts`, `prisma/migrations/20261114190000_scheduled_sales/`.

**A product's regular price is `Product.baseRetail`; a sale gives it a sale price for
a run of the store's days.** `Sale { name, startsOn DATE, endsOn DATE (inclusive),
note, createdBy, endedEarlyAt?, endedEarlyBy? }` and `SaleItem { saleId, productId,
salePrice Decimal(10,2) }`, unique `(saleId, productId)`. CHECKs (copied into
`prisma/testing/db-guards.sql`): `Sale_dates_ordered` (endsOn >= startsOn),
`Sale_endedEarly_complete` (who and when together), `SaleItem_salePrice_positive`.
Nothing is written when a sale starts or ends, and `baseRetail` never changes: the
retail writer and its ledger are untouched by a sale.

**One resolver, `lib/pricing/salePrice.ts`** (rule 42). A sale price applies while
`startsOn <= today <= endsOn`, the sale isn't ended early, and it is below the regular
price (a regular price cut below a scheduled sale price wins). "Today" is the store's
day (`saleToday()`, `AppSettings.timezone`), never the browser's. Every reader goes
through it:

| Reader | What it gets |
|---|---|
| `GET /api/products`, `GET /api/products/find-by-identifier` | `baseRetail` is today's price (what `catalogRetailPrice` reads), plus `regularRetail`, `onSale`, `saleEndsOn` (`retailResponseFields`), with part C's trade fields beside them (`lib/pricing/screenPricing.ts`) |
| `catalogLinePolicies` (`lib/sales/discountApproval.ts`, through `catalogRetailFor`) | The list price of a PRODUCT line and whether it is a sale price: the sale price, so a sale line needs no manager PIN at `discountLimitPercent` 0, a further discount is measured from it, and `OrderLineItem.listPrice` records it. For a trade customer, whether the tier applies to it ("Trade tier pricing") |
| `duplicateOrder` | Today's prices, through `catalogLinePolicies`, on the store's day |
| `POST /api/service/house-calls` | The service line it books on a new quote: net and list price through `catalogLinePolicies`, so a house-call service on sale is booked at its sale price, and a trade customer's at their tier as any catalog product. A service product can go on a sale like any other |
| Product, sale and law tags (`renderProductTag`) | `baseRetail` field = today's price; a SALE tag's was price = the regular price during a sale (`saleTagFields`) |

Consumers of the two product routes that edit the product read `regularRetail`, never
`baseRetail`: `components/modals/ProductEditModal.tsx` (it saves every field it shows,
so it would have written the sale price as retail), and the All Products list's Retail
column shows the regular price with "Sale $X" beside it. The register and New Quote
search results (`components/sales/RetailPriceTag.tsx`), the POS cart row and the quote
line show the sale price with the regular one struck through, from
`lib/pos/cartPricing.ts` `catalogSale`, which only reads the route's `onSale`. A cart
row or quote line says SALE only while its price is still the sale price it was added
at (`lineSale`): typing another price over it drops the note.

**Reports' retail value of stock stays on `baseRetail`** (the regular price), not the
day's sale price.

**One sale price per product per day.** No unique key can say it (a range overlap), and
none is tried over a nullable column (rule 64). Every write of a sale's products locks
those `Product` rows `FOR UPDATE` in id order (as the retail writer does), then looks
for an item of another sale, not ended early, on an overlapping day, and refuses the
write naming it. Two people scheduling the same product queue on the row lock; the
second is refused. A sale ended early blocks nothing.

**Screen and routes.** Inventory › Sales (`/app/inventory/sales`), gated
`catalog.pricing`, like every route under `pages/api/pricing/sales/`:

| Route | What |
|---|---|
| `GET /` | Every sale with its status on the store's day (`UPCOMING`, `ON`, `ENDED`) and product count, and `today` |
| `POST /` | `{ name, startsOn, endsOn, note?, items? }`: one transaction, `SALE_SCHEDULED` |
| `GET /[id]` | The sale and its products with regular and sale prices |
| `PATCH /[id]` | Name and note any time; dates (both) and items only while `UPCOMING`; items replace the set; new dates re-check every product kept. `SALE_CHANGED` |
| `DELETE /[id]` | Only `UPCOMING`. `SALE_DELETED` |
| `POST /[id]/end` | Only `ON`: sets `endedEarlyAt`/`By`, rows stay as the record. `SALE_ENDED` |
| `POST /preview` | `{ selection, pricing, startsOn, endsOn, saleId? }`: each product's sale price or skip reason. Writes nothing |
| `GET /tags-to-change` | Products whose tag changes today (below) |

- A sale starts today or later; a past start is refused.
- Products are chosen with the mass change's filter and selection
  (`components/pricing/ProductPicker.tsx`, shared with the mass change screen; list
  from `GET /api/pricing/mass-change`, same 2,000 cap, "all matching" resolved again
  on the server). A sale carries at most 2,000 products (`SALE_MAX_ITEMS`); the save
  routes refuse more with `saleSizeProblem`'s message, and the editor shows the same
  message against its draft and disables Save, since each preview round adds to it.
- Pricing: `PERCENT_OFF` of the regular price, rounded by the run's rule or the
  store's (`roundRetail`), or a typed `AMOUNT`, used as typed (`planSalePrice`).
  Preview skips with a reason (`SALE_SKIPS`): `NO_RETAIL`, `OVERLAPS` (naming the
  sale), `NOT_BELOW_REGULAR`, `ROUNDS_TO_ZERO`. Saving refuses such an item with a
  400 ("Preview again") rather than skipping it.
- The screen builds a draft: each preview's priced rows are added
  (`addPreviewToItems`; a product already there takes the new price), rows can be
  removed, and Save sends the whole set. For an existing sale it sends only what
  changed (a started sale refuses dates or items even if unchanged).
- Audit events are in the "prices" group, target type `sale`, written inside each
  transaction; the routes are in `__tests__/auditCoverage.test.ts` SENSITIVE.

**Tags to change** (`tagsToChange`): SALE tags for products in a sale starting today
(and on sale today); PRODUCT tags for products whose sale ended yesterday or was ended
early since the start of yesterday, and that aren't on sale today. A product whose old
sale ended and whose new sale starts today is listed once, for the new SALE tag. The
screen prints them through `POST /api/print-label/batch` with `kind` (see
`docs/domains/printing.md`). Nothing prints them on a schedule.

**Demo seed.** `prisma/seed/demo/sales.ts` writes one ended, one current and one
upcoming sale with invented names through `createSale`.

**Tests.** `__tests__/integration/scheduledSales.integration.test.ts` (overlap and the
concurrent write, day boundaries in the store's time zone, every reader, tags, batch
kind, lifecycle, preview, tags to change, audit, the seed);
`__tests__/scheduledSales.test.ts` (resolver, status, parsers, tag fields);
`__tests__/scheduledSalesScreen.test.ts` (the screen's draft and list helpers,
`catalogSale`, `lineSale`, `saleSizeProblem`, batch splitting). The integration file
also proves a sale is never counted against itself (date-only and same-product
changes, the preview with `saleId`) and that a house call books the sale price.
## Trade tier pricing

GAP-06 part C, 2026-11-14, DECISIONS 61. A manager gives a customer a trade tier
(`TradeTier`: a name and a `discountPercent`); on each eligible line of that
customer's sales the price is the item's price today (its retail, or its sale price
while a scheduled sale is on and the store lets a tier apply to it) less the tier's
percent. Joined with part B 2026-11-14; source read then: `lib/sales/discountApproval.ts`,
`lib/pricing/screenPricing.ts`, `lib/pricing/tradeEligibility.ts`,
`lib/pricing/tradeTier.ts`, `lib/sales/duplicateOrder.ts`,
`pages/api/service/house-calls/index.ts`, `pages/api/products/*`.

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
`/api/products/find-by-identifier` return `tradeEligible` for each product
(`lib/pricing/screenPricing.ts` `screenPriceFields`, one home for both lookups), so the
screens agree with the server.

**Sale items** (parts B and C together). `AppSettings.pricing.tradeDiscountOnSaleItems`,
false by default (the strictest), read by `loadTradeSettings`
(`lib/pricing/tradeEligibility.ts`) through the writer's transaction.
`parsePricingConfig` reads it true only when stored as exactly `true`. Whether an item
is on sale is the scheduled-sale resolver's answer on the store's day:
`catalogRetailFor` in `lib/sales/discountApproval.ts` reads `effectiveRetailFor`
(`lib/pricing/salePrice.ts`) and is the only place the policy learns a product's price
and sale flag.

| Trade customer, item on sale | Setting off (default) | Setting on |
|---|---|---|
| Sells at, with no PIN | the sale price | the sale price less the tier |
| `listPrice` | the sale price | the sale price |
| `tradeTierId`, `tradeDiscountPercent` | null | the tier, its percent |
| The tier off the sale price | a cashier's discount (PIN at limit 0) | the entitlement |

The product lookups carry `onSale` and the store's `tradeDiscountOnSaleItems` beside
`tradeEligible` (`screenPriceFields`), each line keeps them (`tierFieldsFromLookup`),
and `priceLineForTier` hands them to `entitledUnitPrice`, so the price a screen sends
is the one the server accepts without a PIN. The setting rides on each product rather
than its own route because a line must carry everything that prices it: a line added
while the customer is still unknown is re-priced when one is picked.

**The discount policy.** `lib/sales/discountApproval.ts`. A tier is an entitlement a
manager set, not a cashier's discount:

- `LinePolicy { listUnit, listOnSale, baselineUnit, trade }`. `listUnit` stays the
  retail and is what `OrderLineItem.listPrice` records, so the order screen and
  receipts show the whole saving. `listOnSale` is whether that list is a sale price,
  recorded beside it as `OrderLineItem.listOnSale` (migration
  `20261114210000_line_list_on_sale`): every writer spreads `recordedList(policy)`,
  so the two are always written together. `baselineUnit` is the entitled price, and a discount is measured from
  it: a sale at the trade price needs no manager's PIN; anything below it is a
  discount like any other.
- `catalogLinePolicies(db, lines, { customerId, today })` is the one function that
  decides a catalog line's list and baseline, part B's sale price and part C's tier
  together. It builds the policy for create-from-cart, add-line
  (`orders/[id]/line-items.ts`), replace-line (`line-items/[lineItemId].ts`),
  `duplicateOrder` (today's prices under the customer's tier today, on the store's day)
  and a house call's service line (`POST /api/service/house-calls`). A configured or
  custom cart line has no product to price, so it takes its own price.
- A price edit on an existing line measures from `currentLinePolicies`: what the line
  recorded (`existingLinePolicy`), or what the order's customer's tier makes of the
  list price it recorded, whichever is lower. The tier is asked about that list with
  the sale flag the line recorded beside it (`listOnSale`), never whether the product
  is on sale today: a list written at a sale price stays one after the sale ends, and
  a list written at the regular price isn't one because a sale started since. Raising the price above the entitled
  price clears the line's tier; bringing it back down to the entitled price is no
  discount and records the tier again (a customer whose tier has since gone keeps
  only what the line recorded).
- **A house call takes the tier.** Its service line is a catalog product sold to the
  customer, so it gets the same eligibility rules (the vendor allows it, not a
  protection plan, a sale price only when the store says so), sells at its baseline and
  records the tier. Part B's `catalogListUnits` (list price with no customer) is gone:
  it had no caller left once the house call priced for its customer.

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
Quote keep each line's `retail` (its price today, the sale price during a sale),
`tradeEligible`, `onSale`, `tradeDiscountOnSaleItems`, `priceTyped` and `tradePercent`
(`tierFieldsFromLookup`); picking, changing or removing the customer re-prices every
untyped line through `priceLineForTier`, so taking the customer off restores retail.
The register's scan and search fetch a product's stock before adding it, so
`addProductToCart` prices the new line inside the cart updater from `tradeTierRef`,
which `chooseCustomer` (the only setter of the customer) sets on every pick: a
customer picked while the fetch is out prices that line too. A
typed price sets `priceTyped`. A tier-priced sale line still says SALE: the screens
pass an untyped line's `retail` to `lineSale`. The order screen shows "Trade N%" beside
a line's saving.

**A quote changing hands.** `PUT /api/sales/orders/[id]` with a new `customerId` on a
quote with no payment (a pending one included) runs `repriceQuoteTrade`
(`lib/sales/quoteTradePricing.ts`) and then `rerateQuoteTax`. Only lines still at the
price they were written at (their list, or the trade price they recorded) are
re-priced; a typed or discounted line keeps its price. Each re-priced line keeps its
`listPrice` and gets a PRICE_CHANGE history entry. The new customer's tier is asked
about each line's recorded list with its recorded `listOnSale`, as a price edit is:
with the setting off, a walk-in's quote written at a sale price gets no tier when
handed to a trade customer, during the sale or after it ends, and one written at the
regular price gets the tier even while a sale is on. The response carries
`repricing { repriced, kept, message }`, which the order screen shows. Whether it is a
handover is decided by what the order is in the database (a quote), never by the
status the request asks for: a request that also makes it an order (a store allowing a
sale with nothing paid) re-prices it for the new customer first, then promotes it.

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

**Tests.** `__tests__/tradeTier.test.ts` (the helper, `priceLineForTier`,
`tierFieldsFromLookup`), `__tests__/integration/tradeTierPricing.integration.test.ts`
(every writer, the quote re-price, the route, the vendor audit and the setting, against
the real database), `__tests__/integration/tradeTierSales.integration.test.ts` (a trade
customer and a sale item with the setting off and on, at the register, adding a line,
duplicate and a house call, and the lookups' price passing the server with no PIN; a
price edit and a quote changing hands during a sale and after it ends, judged by the
`listOnSale` each line recorded; every writer recording it),
`__tests__/posTradeTierRef.test.ts` (the register prices a line added after a stock
fetch for the customer picked during it: source-text tripwire, the unit project has no
DOM renderer).

**Left open:** a tier on proposals' typed B2B prices, per-category tier exclusions, a
tier on configured lines, carrying a tier through a customer merge, billing invoices
(the tRPC billing router). Lines written before `listOnSale` existed were set by the
migration, failing closed: a line whose list is below its product's regular price, or
equals a price one of the product's sales set, reads as listed on sale. A product
whose regular price was raised since such a line was written can read as on sale when
it wasn't; that line then takes no tier off its list unless the store's setting is on.

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
- Reads its lines and numbers through `parseBoundary.ts` from the seam
  `parseHDProposalText` (step 6 of "Adding a New Vendor" below): a line is cut to
  1000 characters, an amount that overflows reads as 0, a freight or install total
  that overflows is 0, and each is a warning on `proposal.warnings`. The route
  writes the quote as read and returns the warnings with it; the import page lists
  them above the quote (2026-11-21). Whether a warning should refuse the import is
  the owner's open question.

Import page at `/app/sales/import-hd`, nav card on the Sales hub.

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
6. If the parser uses `pdf-parse`, ensure it is NOT imported from client-side code.
   Read upload text only through `lib/pricing/parseBoundary.ts` (rule 42), from a
   synchronous `parse*Text(text)` seam that the PDF or buffer entry calls, so the
   fuzz tests can drive it; never call `Number.parseFloat`/`parseInt` on upload
   text. A number too large for a double (about 1.8e308: every run of 310 digits,
   and some of 309) reads as `Infinity`, which slips past
   `Math.abs(qty * price - total) > 0.01`. What a value that does not read becomes
   depends on what the field means:

   - **Order parsers read it as 0 and keep the line** (`parseMoney`, `finiteFloat`,
     `finiteInt`): Aesthetic Movement, Beatriz Ball, BrandWise, Frank & Eileen, K&K,
     MarketTime, SuperCat, Wendover, and since 2026-11-21 nuORDER, Z Supply and
     Hunter Douglas. A $0 line trips no line-math check of its own (0 x qty = 0), so
     what tells the buyer is `splitLines(text, warnings)`, the first thing each seam
     calls: it cuts a line to 1000 characters so the quadratic-backtracking regexes
     see a bounded string, and puts a warning on the order when it cut a line or
     met a number of 300+ digits. A 308-digit number still reads, and overflows
     once doubled or added, so a total of read amounts goes through `finiteSum`
     (0 when the sum overflows); Wendover reads a line total too large to count in
     cents as a $0 unit cost; Z Supply leaves out, with a warning naming the
     style, an item whose pack count or price overflows once multiplied out to
     sizes.
   - **A parser that can name the cell leaves the line out, with a warning naming
     it.** Simblist CSV does so for a Quantity that is not a whole number of up to
     nine digits and for a Unit or Total Price that is not a finite number ("Infinity", "1e999", a
     400-digit run; until 2026-11-21 these imported at $0 and nothing named them).
     A BLANK price still reads as $0, as it always has; whether it should be left
     out too is the owner's open question. Simblist reads cells, not lines, so it
     never calls `splitLines`. The nuORDER printout drops a block whose wholesale
     price does not read, and does not match a line total or Grand Total too long
     to be real, so those fall into its "no line total" and "Grand Total not
     found" refusals.
   - **Price books leave the cell out, as they do "N/A":** `finiteOrNull` gives
     null, and `pricingUtils.parseCurrency` gives NaN, its "no price in this
     cell". Until 2026-11-21 an overflow there read as `Infinity`, which passed
     every caller's `isNaN` check and `cost > 0` filter.

   `__tests__/fuzz/vendorOrderParsers.fuzz.test.ts` fuzzes every order parser
   through its seam (`docs/testing/fuzzing.md`); its `KNOWN_FAILURES` is empty.
   **Unswept, planned as a second PR:** the price-book parsers (Ekornes, Kingsley
   Bate, Brown Jordan, Jensen Leisure, Summer Classics, Gat Creek, CR Laine, the
   dual-grade extractor, SE, `pdfTableExtractor`, Wesley Hall, `wholesale/columnGrid`)
   still call `parseInt` / `parseFloat` directly besides `parseCurrency`, have no
   text seams and no line cut, and are not fuzzed; nor does a test yet list every
   file under `lib/pricing` as fuzzed or not a parser.
7. Key every lookup built from upload or request text (tier codes, collection
   names, program types) with a `Map`, never `{}`: a plain object drops a key
   named `__proto__`, and reads `constructor` / `toString` back as functions,
   which pass an `if (!tierId)` check and fail later in Prisma. Upsert
   collections with `upsertCollectionIds()` (`lib/pricing/upsertCollectionIds.ts`).
   Regexes over uploaded text use bounded runs (`{1,200}`, not `+`) where a
   run is followed by a literal, as `extractCushionOptions()` does: an
   unbounded run is quadratic on a long line with no match (CodeQL
   js/polynomial-redos; 2026-10-15). A character class that also matches `\n`
   (`[A-Za-z\s]`) is not bounded by the 1000-character line cut, so bound it
   too (nuORDER's footer). An unanchored money pattern can be pinned to the
   first digit of a run with `(?<!\d)` where that changes no match: a match
   that starts after a digit also matches one digit earlier (MarketTime's
   money tails, 2026-11-21)

## Verification Checklist

- [ ] `npm test -- wesleyHallParser priceCalculator pricingUtils` passes
- [ ] New parsers using `pdf-parse` are in separate files, not imported client-side
- [ ] Import creates both VendorStyle and Product in a transaction
- [ ] Grade tiers auto-extend correctly (60 for fabric, Z for leather)
- [ ] Option seeds use upsert to preserve manual edits
- [ ] Vendor added to `productEntryMapping.ts` for POS matching
- [ ] Vendor runbook created or updated
- [ ] Lookups keyed by upload text are `Map`s (step 7)
- [ ] An order parser has a pure seam (a line-based `parse*Text` starts with
      `splitLines`) and a case in `__tests__/fuzz/vendorOrderParsers.fuzz.test.ts`
      (step 6)

## Test Coverage

Well covered: `wesleyHallParser.test.ts` (389 lines), `priceCalculator.test.ts`, `pricingUtils.test.ts`

Gap: no source-text tripwire ensuring that any new `pdf-parse`-using file isn't imported from a page. The constraint is enforced today only by failed Next.js builds when violated.

---

Last verified: 2026-05-20; "Retail is changed in one place", "Scheduled sale prices" and the unique-constraint correction 2026-11-14 against source; "HD Proposal import path" and "Adding a New Vendor" steps 6-7 2026-11-21 against source.
