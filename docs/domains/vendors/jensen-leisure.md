# Jensen Leisure

Outdoor furniture. Retail-first pricing with lettered grades.

**Pricing model**: GRADE_BASED (retail-first)
**the POS name**: "Jensen Leisure"
**Alias key**: "jensen leisure"

## Parser

| File | Purpose | Server-only? |
|------|---------|-------------|
| `lib/pricing/jensenLeisureParser.ts` | PDF parser for retail price lists | No |

## Import Endpoint

`api/pricing/import/jensen-prices.ts` -- dedicated endpoint.

## Grade System

Fabric grades: C, D, E, U. Retail prices in the book, cost derived via multiplier.

## Pricing Structure

- Frame-only items
- Cushion-only replacement items
- Combined frame + cushion items
All graded by the same C/D/E/U system.

## Key Files

- `lib/pricing/jensenLeisureParser.ts` -- PDF parser
- `pages/api/pricing/import/jensen-prices.ts` -- dedicated import endpoint

---
Last verified: 2026-04-07
