# Gat Creek / Caperton

American hardwood furniture. Species-based and multi-axis pricing (wood type x dimensions).

**Pricing model**: SPECIES_MATRIX / MULTI_AXIS
**the POS name**: "Gat Creek"
**Alias key**: "gat creek"

## Parser

| File | Purpose | Server-only? |
|------|---------|-------------|
| `lib/pricing/gatCreekExtractor.ts` | PDF parser for wholesale line items and custom shop grids | No |

## Import Endpoint

`api/pricing/import/wood-prices.ts` -- handles species-based and multi-axis pricing.

## Pricing Structure

Two sections in the price book:

**Wholesale line items**: Up to 5 wood species with a price per species per style.

- ASH, CHERRY, MAPLE, WALNUT, PAINT

**Custom shop grids**: Width x Length x Species matrices, or Diameter x Species matrices. Up to 3 pricing dimensions (MULTI_AXIS model).

## Grade System

No fabric/leather grades. Price varies by wood species (a `VendorPriceDimension` of type "Wood Species") and optionally by physical dimensions.

## Known Quirks

- Custom shop grids create MULTI_AXIS pricing with up to 3 dimensions -- more complex than any other vendor.
- PAINT is treated as a "species" even though it's a finish, because the pricing structure is the same.

## Key Files

- `lib/pricing/gatCreekExtractor.ts` -- PDF parser
- `pages/api/pricing/import/wood-prices.ts` -- dedicated import endpoint

---
Last verified: 2026-04-07
