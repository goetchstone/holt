# Imports Overview — One Canonical Reference

Everything that flows data INTO our DB from the POS (or any other source). Read this first; the per-import domain runbooks have the details for each path.

This doc exists because 2026-05-20 was the day we discovered we had **3 import-related bugs latent at once** (BOM-strip never tripped on the manual customers path until that day, quote-runner never read Cuscode, temp-items runner hardcoded CONFIRMED) plus 2 the POS-side renames AND a 387-row barcode-duplicate data-quality issue — too many moving pieces to keep in scattered runbooks. This is the single-source map.

## The two ingestion paths

| Path | Cadence | Trigger | Surface |
|---|---|---|---|
| **Gmail → automated daily orchestrator** | Daily 06:10 ET via Synology cron | `scripts/auto-import.sh` → `POST /api/automations/gmail-import` (Bearer auth) | 13 routes in `lib/gmailReportRouter.ts` |
| **Manual products import** | Ad-hoc, owner-triggered | `/admin/import/POS-products` UI upload | `runthe POSProductsImport` |

Plus a few one-off / legacy paths (FileMaker `lib/fmApiClient.ts`, Windfall weekly CSV via `/admin/import/windfall`, HD Proposal PDF) — covered in `integrations.md`.

## The 14 daily-import routes

Configured in `lib/gmailReportRouter.ts`. Each filename regex maps to one runner.

| the POS filename pattern (regex) | Route → runner | Domain runbook |
|---|---|---|
| `Prior_Day_Sales_Data_Export` | sales → `runSalesImport` | `import-pipeline.md`, `sales-orders.md` |
| `Daily_Quote_Report` | quotes → `runQuotesImport` | `sales-orders.md` |
| `Customer_Deposits_Export` | deposits → `runDepositsImport` | `accounting.md` |
| `SH_Stock_by_Item` | stock → `runStockByItemImport` | `inventory.md` |
| `Prior_Day_Received_Items` | received-items → `runReceivedItemsImport` | `purchasing.md` |
| `Prior_Day_Temp_(Items\|Purchase_Orders)` | temp-items → `runTempItemsImport` | `purchasing.md` |
| `SH_Purchase_Order_Line_Export` | po-lines → `runPOLineExportImport` | `purchasing.md` |
| `Company_Inbound_Items` | inbound-items → `runInboundItemsImport` | `purchasing.md` |
| `Inbound_Items` (generic, fallback) | purchase-orders → `runPurchaseOrdersImport` | `purchasing.md` |
| `Prior_Day_POR_Export` | purchase-orders → `runPurchaseOrdersImport` | `purchasing.md` |
| `Prior_Day_Payments_Export` | payments → `runPaymentsImport` | `accounting.md`, `pos.md` |
| `Prior_Day_Invoice_Export` | invoices → `runInvoicesImport` | `accounting.md` |
| `Company_(Prior_Day_)?Customers` | customers → `runCustomerImport` | `customer-intelligence.md`, `import-pipeline.md` |
| `SH_Item_Export` | products → `runProductsImport` | `import-pipeline.md` |

**Route order matters.** First match wins. The specific `Company_Inbound_Items` pattern is listed BEFORE the generic `Inbound_Items` fallback so the more-specific runner is preferred.

**BOM stripping**: the gmail orchestrator (`pages/api/automations/gmail-import.ts`) passes a `transformHeader` to Papa.parse that strips the U+FEFF byte-order mark and trims surrounding whitespace from header names. the POS ships some CSVs (including `SH_Item_Export`) with a UTF-8 BOM that would otherwise become part of the first column key (the first column header would parse as `U+FEFF` + `Active` rather than `Active`) and silently break alias matching. Added 2026-05-26 with the SH Item Export wiring.

## 2026-05-20 renames (owner-side the POS changes)

The owner renamed two reports on the POS's side to scope them to prior-day-only data. Both router regexes are permissive — accept old AND new names — so a fallback to the legacy filename still routes correctly.

| Was | Now | Why |
|---|---|---|
| `Company_Customers.csv` | `Company_Prior_Day_Customers.csv` | Scope to prior-day-only data (not the entire historical customer master) |
| `Prior_Day_Temp_Items.csv` | `Prior_Day_Temp_Purchase_Orders.csv` | Clearer semantic name on the POS's side |

Both renames are documented in `docs/domains/import-pipeline.md` and pinned by tests in `__tests__/gmailReportRouter.test.ts` (legacy regression + post-rename coverage both present).

## Products import (catalog refresh)

**Two entry points, ONE runner.** Both call `runProductsImport` in `lib/importRunners.ts`.

### Daily auto-import — `SH_Item_Export.csv` (2026-05-26+)

Owner direction 2026-05-22: *"ensure this file gets imported too during the automated gmail imports."* Wired in 2026-05-26.

- ~100K rows per day, all marked `Active = yes` (the POS omits discontinued products from this export)
- 17 columns: `Active, Barcode No, Department, Category, Categorytype, Id, Supplier, Part No, Product Description, Product Name, Selling Price, Purchasing Cost, Supplier Cost, Item Height, Item Length, Item Width, Product Family`
- Ships with a UTF-8 BOM — stripped by `transformHeader` in the orchestrator (see above)
- **Weight is NOT in the export** — the POS doesn't capture weight on their product master. Manual uploads can still set it.
- **`Supplier Cost` is parsed but not currently used.** Consignment rugs show `Purchasing Cost = 0` (we don't pay until sold) and `Supplier Cost = $X` (what we owe on sale). The actual consignment accounting lives in the `ConsignmentItem` model; the product-table `baseCost` continues to read from `Purchasing Cost` for the manual-upload-compatible behavior.

### Manual upload — `/admin/import/POS-products`

Triggered ad-hoc by an admin uploading the POS "Items / Products" CSV (older filename pattern `upload_templatereport*.csv`).

- Same column-alias matching as the auto-import path (both old `part_no` and new `Part No`, etc.)
- "Skip inactive/discontinued" checkbox → `skipInactive: true` on the runner. Existing inactive products are left untouched on update.

### Common runner behavior

1. **Self-chunks 500 rows per batch** — one DB transaction per chunk to stay under Postgres parameter limits.
2. **Batched pipeline within each chunk** — `createMany` for new products, `$transaction(updateOps)` for existing; per-row fallback if the batch fails.
3. **Lands missing taxonomy as placeholders** (`Unknown Vendor`, `Uncategorized` dept + cat) rather than skipping the row.
4. **Active column handling** — `Active = yes` (case-insensitive, also `y` / `true` / `1`) flips `isActive=true, isDiscontinued=false` on the product. `Active = no` flips `isActive=false`. Absent or blank `Active` leaves the flags untouched (legacy manual-upload behavior — preserves operator overrides).
5. **Barcode placeholder**: `Barcode No = "0"` (the POS's "no barcode" sentinel) is ignored — no `Upc` row written.
6. **Auto-links historical line items** scoped to imported part numbers + barcodes via `backfillLineItemProductLinks` — runs ONCE at the end of the run (not per chunk).
7. **Upc table linkage**: barcodes are upserted; if a barcode is already in `Upc` pointing at a different product, the import RE-ASSIGNS it to the latest product (silent — see "Barcode collision behavior" below). the POS-side barcode uniqueness is NOT enforced; see CLAUDE.md gotcha rule 13.

### Active=yes is INFORMATIONAL, not normative

Because every row in the daily export is Active=yes by definition, the runner's only side effect for the daily import is "reactivate anything an operator inadvertently inactivated." Genuine discontinuation goes through the **transfer-out workflow** (separate from this path); the daily import alone won't mark anything as discontinued. If we want that behavior in the future, it's a separate post-import sweep: "products present in last week's export but absent from today's → mark as discontinued."

## Cuscode handling

the POS's customer code (the `Cuscode` column) is the canonical the POS-side customer identifier. Per owner direction 2026-05-20: **"we get sent a cuscode for every order."**

| Path | Reads Cuscode | Status |
|---|---|---|
| Sales import | ✓ | Always did |
| Customer import | ✓ | Always did (after PR #301 BOM-strip fix on the manual upload path) |
| Payments import | ✓ | Always did |
| Invoices import | ✓ | Always did |
| **Quote import** | ✓ post-PR #309 | Was the gap until 2026-05-20 — owner added Cuscode to the POS's Daily Quote Report export THE SAME DAY we shipped #309 |

Cuscode round-trip:

- `findOrCreateCustomer` (in `lib/importHelpers.ts`) — looks up by cuscode first, then email+name, then name. If no match, creates a placeholder Customer with the cuscode link.
- `Customerthe POSId` table — `POSId @unique` mapping cuscode → Customer.id
- `SalesOrder.POSCuscode` — the cuscode value at import time, persisted on the order for downstream linkage even if `customerId` changes later

## Postatus → PurchaseOrderStatus mapping

the POS's `Postatus` column is converted via `derivePOStatus()` in `lib/importHelpers.ts`:

| the POS value | → Our `PurchaseOrderStatus` |
|---|---|
| `received` | `RECEIVED_FULL` |
| `cancelled` | `CANCELLED` |
| `part received` | `RECEIVED_PARTIAL` |
| **`temporary`** | **`DRAFT`** (added 2026-05-21 in PR #315) |
| (any other / blank) | `CONFIRMED` (fallback) |

`runTempItemsImport` was hardcoding `CONFIRMED` regardless of Postatus until PR #315. The bug was latent — the runner had never executed against real data because the router was looking for the old `Prior_Day_Temp_Items` filename. Both halves were fixed on 2026-05-20–21 (router rename + status mapping).

## the POS-side data quality findings (2026-05-21 audit)

These are NOT bugs in our import code — they're issues IN the POS's data that we observe and either route around or surface for cleanup.

### 1. Barcode duplicates (387 rows, owner cleaning up)

Per 2026-05-21 audit of `upload_templatereport (47).csv`:

| Bucket | Rows | What |
|---|---|---|
| `PLACEHOLDER_ZERO` (barcode = "0") | 10 | Marjan rugs missing a real barcode — the POS needs to clear those to NULL |
| `DIFFERENT_PRODUCT_COLLISION` | 151 | Unrelated products sharing one barcode (e.g. gold mezuzah charm + bedding pillow on `100217747`) |
| `SAME_PRODUCT_VARIANTS` | 226 | Same product name with multiple `part_no` entries sharing a barcode (Apparel-heavy) |

**Barcodes are supposed to be unique per SKU (GS1/UPC/EAN standard).** All 387 rows are bugs the POS needs to fix. The owner is doing this cleanup directly in the POS — no code change on our side.

89% of the affected products landed in our DB on **2026-03-14** (our bulk products import day) — meaning the POS already had the dups when we did the import. The remaining ~44 came in via auto-create paths in April + May.

### 2. Barcode collision behavior in our import code

When a CSV row has a barcode that already exists in `Upc` pointing at a different product, the manual products-import runner **re-assigns the barcode to the latest product**:

```ts
// pages/api/import/POS-products.ts:403-405
} else if (currentProductId !== productId) {
  upcUpdates.push({ upc: p.barcode!, productId });  // Re-assigns!
}
```

Then later (line 420-428) the update transaction fires and the OLD product loses its barcode link. This is **silent** — no warning surfaced to the operator.

Consequence: the most-recently-imported product owns the barcode. Earlier same-barcode products end up with no `Upc` row, so scan-at-register can't find them.

**Not changing this behavior right now** (per CLAUDE.md rule 18 — owner explicitly said "this is not anything to do with our code base, fix the POS first"). Once the POS's barcode dups are resolved, this code path won't fire on real data anyway.

### 3. Department/Category gap on auto-created products

Per CLAUDE.md gotcha + the "Import Dept Gap" memory entry: when a sales/PO/receiving import sees a part_no that's not in our catalog, it auto-creates a minimal Product row using `findProduct({ autoCreate: true })`. Those minimal rows land with NO department/category (placeholders). 488 line items / $633K are uncategorized in leveling because of this. Owner manages via the Categorize Products tool at `/admin/tools/categorize-products`.

This is by-design behavior — auto-create unblocks sales-import flow when the POS delivers a part_no before the customer-master refresh has it. The taxonomy gap is the trade-off.

### 4. NULL-handling traps in the POS columns

CLAUDE.md rule 51 ("Nullable columns: never use a naked `not:` filter"). Verified-stable list:

- `Payment.status` — 44K legacy NULL rows. Use `OR: [{ status: null }, { status: { not: "VOIDED" } }]`
- `OrderLineItem.productName` — 172 NULL rows. Same pattern.
- `OrderLineItem.lineItemStatus` — 67K NULL legacy rows (backfilled to `ACTIVE` 2026-05-05).

Plus the `Customer.email @unique` collision pattern (PR #214/#299) — pre-flight `findUnique` before any email update or create.

## Self-heal patterns

When something breaks in the POS-side data, two recovery paths:

1. **Self-heal on next import.** Most things — quote runner re-pulls quoteCode + Cuscode, sales runner reactivates orphan-cancelled lines, customer runner late-hydrates name/email. Just wait for tomorrow.
2. **One-off migration.** When the bug was latent for a while and self-heal can't catch up (e.g. quote-runner never wrote cuscodes for 14 customers because the runner had a code bug — those needed a migration to be merged with their placeholders).

The 2026-05-21 placeholder-merge migration (`20260521_merge_POS_placeholders`) is the canonical example of (2). The router-fix in PR #314 is (1) — once shipped, the next quote import re-processes all 228 active quotes and writes the cuscode links naturally.

## Verification checklist (before touching any import code)

- [ ] Cross-check the router regex against the actual the POS filename (current canonical set is in `/Downloads/dailyimports-2/` — owner can re-download)
- [ ] Cross-check Cuscode is being passed to `findOrCreateCustomer` (4 sites today: sales, customers, payments, quotes — all confirmed 2026-05-21)
- [ ] Verify `derivePOStatus(row.Postatus)` is used for any PO-creating path (3 + temp-items = 4 sites)
- [ ] Per CLAUDE.md rule 19: don't add a runbook claim about an import behavior until you've actually read the runner code

## Test coverage

| File | Tests | Type |
|---|---|---|
| `__tests__/gmailReportRouter.test.ts` | 22 | Unit — exact-name + post-rename + skip-pattern routing |
| `__tests__/importHelpers.test.ts` | 79 | Unit — derivePOStatus, splitCustomerName, isReturnOrder, etc. |
| `__tests__/importRunners.regression.test.ts` | 21 | Source-text tripwires for every prod failure that's hit a runner |
| `__tests__/integration/runSalesImport.integration.test.ts` | 5+ | Real-DB |
| `__tests__/integration/runQuotesImport.integration.test.ts` (`quotesReconcile.integration.test.ts`) | 10 | Real-DB — includes the 2026-05-20 cuscode-hydration scenarios |
| `__tests__/integration/quotesReconcile.integration.test.ts` (cuscode block) | 3 | Real-DB — pinned the post-rename behavior |

Gaps acknowledged: no real-DB tests for the manual products-import path (the upsert-then-reassign barcode behavior is uncovered by tests; only the pure helpers around it are tested).

## Cross-references

- `docs/domains/import-pipeline.md` — runner details + report-to-runner table + rewrites
- `docs/domains/sales-orders.md` — status derivation + return detection + orphan cleanup
- `docs/domains/purchasing.md` — POs + POR + receiving + auto-create-products from imports + the temp-PO Postatus → DRAFT mapping
- `docs/domains/accounting.md` — payments + invoices + deposits + C1 daily reconciliation
- `docs/domains/customer-intelligence.md` — customer leveling + lead scoring
- `docs/domains/mailchimp.md` — Mailchimp sync orchestrator (not the POS-driven; lives separately)
- `docs/domains/integrations.md` — FileMaker, Windfall, Axper, Google services
- `docs/domains/inventory.md` — Stock-by-Item handling + catch-all location pattern

---
Last verified: 2026-05-21
