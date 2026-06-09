# Ekornes (Stressless)

Norwegian recliner and sofa manufacturer. MRP-based pricing with multiple product format handlers.

**Pricing model**: GRADE_BASED (MRP-derived)
**the POS name**: "Ekornes Inc"
**Alias keys**: "ekornes", "stressless"

## Parser

| File | Purpose | Server-only? |
|------|---------|-------------|
| `lib/pricing/ekornesParser.ts` | MRP price book parser with multiple format handlers | No |

## Import Endpoint

`api/pricing/import/ekornes-prices.ts` -- dedicated endpoint. Creates VendorStyles, Collections, grade dimensions, and wood finish option groups.

## Grade System

Fabric/leather grades vary by product line:

- **Recliners**: 4 grades (Batik, Fabric, Paloma, Leather)
- **Sofas**: 4 grades with Paloma variant
- **Admiral**: MAP/MRP pricing (different from standard grade structure)
- **Dining, Mattresses, Accessories**: Flat or simplified grading

## Product Formats

The parser handles multiple distinct PDF layouts within the same price book:

- Recliner pages (grade columns with base/arm size variants)
- Sofa pages (grade columns with Paloma-specific pricing)
- Admiral pages (MAP vs MRP columns)
- Dining pages (simpler layout)
- Mattress pages (size-based)
- Accessory pages (flat pricing)

## Options Seeded

- **Wood Finish**: Multiple stain/finish options seeded as a VendorOptionGroup

## Known Quirks

- Multiple format handlers in one parser -- each product type has different PDF column structures.
- MRP (Manufacturer's Retail Price) is the source price. Cost is derived from MRP.
- Admiral line uses MAP (Minimum Advertised Price) / MRP dual pricing instead of fabric grades.

## Key Files

- `lib/pricing/ekornesParser.ts` -- multi-format PDF parser
- `pages/api/pricing/import/ekornes-prices.ts` -- dedicated import endpoint

---
Last verified: 2026-04-07
