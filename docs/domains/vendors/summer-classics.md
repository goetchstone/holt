# Summer Classics

Outdoor furniture. Wholesale-first pricing with lettered grades.

**Pricing model**: GRADE_BASED (wholesale)
**the POS name**: "Summer Classics"
**Alias key**: "summer classics"

## Parser

| File | Purpose | Server-only? |
|------|---------|-------------|
| `lib/pricing/summerClassicsParser.ts` | PDF parser for wholesale price lists | No |

## Import Endpoint

`api/pricing/import/summer-classics-prices.ts` -- dedicated endpoint.

## Grade System

Fabric grades: A, B, C, D. Wholesale prices listed directly (no retail-to-cost conversion needed).

## Pricing Structure

- Cushioned products with A/B/C/D grades
- Frame-only products (flat price)
- Organized by collection

## Key Files

- `lib/pricing/summerClassicsParser.ts` -- PDF parser
- `pages/api/pricing/import/summer-classics-prices.ts` -- dedicated import endpoint

---
Last verified: 2026-04-07
