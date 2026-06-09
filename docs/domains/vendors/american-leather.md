# American Leather

Leather and upholstery vendor. Dual grade dimensions (leather grade + fabric grade on the same product).

**Pricing model**: GRADE_BASED (dual dimension)
**the POS name**: "American Leather"
**Alias key**: "american leather"

## Parser

| File | Purpose | Server-only? |
|------|---------|-------------|
| `lib/pricing/americanLeatherExtractor.ts` | PDF parser for retail/wholesale price lists | No |

## Import Endpoint

`api/pricing/import/american-leather.ts` -- dedicated endpoint. Handles the dual grade dimension structure that the shared wholesale endpoint doesn't support.

## Grade System

Two independent grade dimensions on the same product:

- **Leather grade**: Letter-based (C, D, E, etc.)
- **Fabric grade**: Numeric or named grades

This means a product can be priced at the intersection of a leather grade AND a fabric grade. The import creates two `VendorPriceDimension` records per vendor.

## Import Structure

- Creates VendorStyles and Collections from parsed PDF data
- Handles per-page layout with collection, program type, and standard features
- Creates grade matrices for both leather and fabric dimensions
- Seeds option groups for power features and mattress options

## Known Quirks

- Dual grade dimensions require the American Leather-specific import endpoint -- the shared wholesale endpoint only handles single-dimension grading.
- PDF layout varies by program type (recliners vs sofas vs beds).

## Key Files

- `lib/pricing/americanLeatherExtractor.ts` -- PDF parser
- `pages/api/pricing/import/american-leather.ts` -- dedicated import endpoint

---
Last verified: 2026-04-07
