# Pricing & Catalog

Vendor price list import from PDF/CSV/XLSX. Multi-dimensional pricing engine. Product catalog management.

**Before working on any vendor parser, read `docs/domains/vendors/common.md` first.** It covers shared patterns: VendorStyle vs Product, grade systems, option seeding, server-only constraints.

## Pricing models

The `VendorPricingModel` enum determines which pricing path the configurator follows. **Adding a new vendor requires choosing the correct model** — picking the wrong one cascades into broken price math the configurator can't recover from without re-import.

| Model | When to use | Example |
|---|---|---|
| `FLAT` | Single price per product, no axes | Most accessory vendors |
| `GRADE_BASED` | Fabric/leather grade matrix (e.g. grades 14–60 for fabric, C–Z for leather) | Wesley Hall, CR Laine |
| `FRAME_PLUS_CUSHION` | Frame + separately-priced cushion fill | Kingsley Bate |
| `SPECIES_MATRIX` | Wood species drives base price | Gat Creek |
| `MULTI_AXIS` | 2–3 pricing dimensions combine (frame × grade × finish) | American Leather (frame + dual grade) |
| `AREA_BASED` | Price per sq ft / sq yard | Rug vendors (not currently active) |
| `SIZE_BASED` | Size class drives price (sofa < loveseat < sectional) | Some Wesley Hall SE configurations |

## VendorStyle vs Product

Both are created during import. VendorStyles are catalog templates ("frames" from a vendor price list); Products are materialized physical items.

- **VendorStyle** — what's in the catalog. Configurable. Lives in `VendorStyle` + `StyleGradePrice` + `StyleAxisPrice` etc.
- **Product** — what you can buy or stock. Linked to a VendorStyle via `vendorStyleId` when materialized from a configurator.

Existing products are upserted by `(productNumber, vendorId)` unique constraint. Re-importing a price list updates VendorStyle pricing but does not blow away product history.

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

## Vendor Runbooks

| Vendor | Pricing Model | Runbook | Parser |
|--------|--------------|---------|--------|
| Wesley Hall | Grade-based + SE | [wesley-hall.md](vendors/wesley-hall.md) | `wesleyHallParser.ts`, `seParser.ts` |
| CR Laine | Grade-based | [cr-laine.md](vendors/cr-laine.md) | `crLaineExtractor.ts` |
| American Leather | Dual grade | [american-leather.md](vendors/american-leather.md) | `americanLeatherExtractor.ts` |
| Ekornes | MRP-based | [ekornes.md](vendors/ekornes.md) | `ekornesParser.ts` |
| Kingsley Bate | Frame + Cushion | [kingsley-bate.md](vendors/kingsley-bate.md) | `kingsleyBateParser.ts` |
| Brown Jordan | Retail grade | [brown-jordan.md](vendors/brown-jordan.md) | `brownJordanParser.ts` |
| Gat Creek | Species matrix | [gat-creek.md](vendors/gat-creek.md) | `gatCreekExtractor.ts` |
| Jensen Leisure | Retail grade | [jensen-leisure.md](vendors/jensen-leisure.md) | `jensenLeisureParser.ts` |
| Summer Classics | Wholesale grade | [summer-classics.md](vendors/summer-classics.md) | `summerClassicsParser.ts` |
| Hunter Douglas | Line-item (proposals) | [hunter-douglas.md](vendors/hunter-douglas.md) | `hdProposalParser.ts` |

## Adding a New Vendor

1. Determine the pricing model (see `common.md` for model descriptions)
2. Create a parser in `lib/pricing/{vendorName}Parser.ts`
3. Create or reuse an import endpoint in `pages/api/pricing/import/`
4. Add vendor name aliases to `resolveVendorKey()` and `POSMapping.ts`
5. Create a vendor runbook in `docs/domains/vendors/{vendor}.md`
6. If the parser uses `pdf-parse`, ensure it is NOT imported from client-side code

## Verification Checklist

- [ ] `npm test -- wesleyHallParser priceCalculator pricingUtils` passes
- [ ] New parsers using `pdf-parse` are in separate files, not imported client-side
- [ ] Import creates both VendorStyle and Product in a transaction
- [ ] Grade tiers auto-extend correctly (60 for fabric, Z for leather)
- [ ] Option seeds use upsert to preserve manual edits
- [ ] Vendor added to `POSMapping.ts` for POS matching
- [ ] Vendor runbook created or updated

## Test Coverage

Well covered: `wesleyHallParser.test.ts` (389 lines), `priceCalculator.test.ts`, `pricingUtils.test.ts`

Gap: no source-text tripwire ensuring that any new `pdf-parse`-using file isn't imported from a page. The constraint is enforced today only by failed Next.js builds when violated.

---
Last verified: 2026-05-20
