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
(`defaultMarkup`, `markupPrecedence`, `retailRounding`) through
`PUT /api/admin/settings`. What is sent is merged over what is stored; a save that
changes nothing writes nothing; `SETTINGS_SAVED` names the keys that moved
(`pricing.retailRounding`). `parsePricingConfig` reads it fail-closed.

**Left open** (ROADMAP GAP-06):

- Trade-tier and customer-group discounts (GAP-06 part C), re-pricing open quotes and
  orders (also when a sale starts or ends: lines keep the price they were added at),
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
`lib/labels/productTag.ts`, `prisma/migrations/20261114180000_scheduled_sales/`.

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
| `GET /api/products`, `GET /api/products/find-by-identifier` | `baseRetail` is today's price (what `catalogRetailPrice` reads), plus `regularRetail`, `onSale`, `saleEndsOn` (`retailResponseFields`) |
| `catalogListUnits` (`lib/sales/discountApproval.ts`) | The list price of a PRODUCT line: the sale price, so a sale line needs no manager PIN at `discountLimitPercent` 0, a further discount is measured from it, and `OrderLineItem.listPrice` records it |
| `duplicateOrder` | Today's prices, through `catalogListUnits`, on the store's day |
| `POST /api/service/house-calls` | The service line it books on a new quote: net and list price through `catalogListUnits`, so a house-call service on sale is booked at its sale price. A service product can go on a sale like any other |
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

Last verified: 2026-05-20; "Retail is changed in one place", "Scheduled sale prices" and the unique-constraint correction 2026-11-14 against source.
