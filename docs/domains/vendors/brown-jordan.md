# Brown Jordan

Outdoor furniture. Retail-first pricing (retail price in book, cost derived via multiplier).

**Pricing model**: GRADE_BASED (retail-first)
**the POS name**: "Brown Jordan"
**Alias key**: "brown jordan"

## Parser

| File | Purpose | Server-only? |
|------|---------|-------------|
| `lib/pricing/brownJordanParser.ts` | PDF parser for retail price lists | No |

## Import Endpoint

`api/pricing/import/retail-grade-prices.ts` -- shared endpoint for retail-first vendors.

## Grade System

- **Cushioned seating**: Grades A through H
- **Sling**: Grades A through C
- **Tables**: Flat MSRP (no grade)

## Cost Derivation

Retail price x 0.44 = wholesale cost. The multiplier is applied during import.

## Known Quirks

- Retail-first means the price book shows retail/MSRP prices. Cost is calculated, not listed.
- Tables have no grade structure -- single flat MSRP per style.

## Key Files

- `lib/pricing/brownJordanParser.ts` -- PDF parser
- `pages/api/pricing/import/retail-grade-prices.ts` -- shared retail-first import endpoint

---
Last verified: 2026-04-07
