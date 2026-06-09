# Vendor Pricing -- Common Patterns

Shared concepts across all vendor pricing imports. Read this before working on any vendor parser.

## Two-Stage Import

1. **Client-side**: User uploads PDF/CSV. Parser extracts structured data (JSON).
2. **Server-side**: Import API endpoint receives parsed data, creates/updates database records in a transaction.

Parsers live in `lib/pricing/`. Import endpoints live in `pages/api/pricing/import/`.

## VendorStyle vs Product

- **VendorStyle** = catalog template from a vendor price list ("a frame"). Has a style number, grade prices, option overrides. Not a physical item.
- **Product** = physical inventory item. Created alongside the VendorStyle during import, linked via `vendorStyleId`.

Import always creates both. Products are upserted by `(productNumber, vendorId)` unique constraint.

## Pricing Models (VendorPricingModel enum)

| Model | How price is determined | Vendors |
|-------|----------------------|---------|
| GRADE_BASED | Price varies by fabric/leather grade tier | Wesley Hall, CR Laine, Brown Jordan, Jensen, Summer Classics |
| FRAME_PLUS_CUSHION | Base frame price + separate cushion grade price | Kingsley Bate |
| SPECIES_MATRIX | Price varies by wood species | Gat Creek |
| MULTI_AXIS | Up to 3 pricing dimensions (species x size x finish) | Gat Creek custom shop |
| AREA_BASED | Price per square foot/yard | -- |
| SIZE_BASED | Discrete sizes with fixed prices | -- |
| FLAT | Single price per product | Marjan, miscellaneous |

## Grade Systems

**Fabric grades**: Numeric (7-60). Lower = less expensive. COM (Customer's Own Material) is grade 0. Grades auto-extend up to 60 during import to support riser extrapolation.

**Leather grades**: Letter-based (C-Z). COM/COL at grade 0. Grades auto-extend through the alphabet.

**Grade riser**: The cost increment per grade step. Used to extrapolate prices for grades not explicitly listed in the price book. Stored on VendorStyle as `gradeRiser`.

**Sort order**: COM/COL first, then numeric ascending, then letter ascending.

## PriceList Versioning

Each import creates a `PriceList` record tracking the vendor, effective date, and version. This allows historical price tracking. The import UI shows which price list is current.

## FabricCatalog

Maps fabric name + color to a vendor's grade tier. Used by the configurator to auto-select the correct grade when a fabric is chosen. Imported via the `fabrics.ts` endpoint.

## VendorOptionGroup / VendorOption / StyleOptionOverride

- **VendorOptionGroup**: Category of options (e.g., "Cushion Upgrade", "Nailhead Trim")
- **VendorOption**: Specific option within a group (e.g., "Comfort Down", "Spring Down")
- **StyleOptionOverride**: Per-style surcharge for an option (e.g., "Comfort Down on style 660 = $150")

Options are seeded via `VENDOR_OPTION_SEEDS` in the import endpoint. Surcharges are mapped via `VENDOR_SURCHARGE_MAP` from parsed product fields. Manual surcharge edits are preserved (upsert with `update: {}` no-op).

## Vendor Name Aliases

`resolveVendorKey()` in `wholesale-prices.ts` normalizes vendor names for matching:

- "CR Laine" / "C R Laine Furniture" / "cr laine" all resolve to "c r laine"

the POS vendor mapping in `productEntryMapping.ts` bridges vendor names to POS supplier names.

## Server-Only Module Constraint

`pdf-parse` uses Node's `fs` and cannot be imported from files pulled into client bundles. **If a parser uses `pdf-parse`, it must live in a separate file that is only imported by API routes.**

- `wesleyHallParser.ts` -- imported by client-side import page. SE logic separated to `seParser.ts`.
- `crLaineExtractor.ts` -- API-only import, safe.
- `hdProposalParser.ts` -- API-only, safe.

## Verification Checklist (All Vendors)

- [ ] `npm test -- wesleyHallParser priceCalculator pricingUtils` passes
- [ ] Parser does not import `pdf-parse` if also imported client-side
- [ ] Import creates both VendorStyle and Product in a transaction
- [ ] Grade tiers auto-extend correctly
- [ ] Option seeds use upsert with `update: {}` to preserve manual edits
- [ ] New vendor added to `productEntryMapping.ts` for POS matching

---
Last verified: 2026-04-07
