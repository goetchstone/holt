# CR Laine

Upholstery vendor. Columnar PDF layout (products side-by-side on each page).

**Pricing model**: GRADE_BASED
**the POS name**: "C.R. Laine"
**Alias keys**: "cr laine", "c r laine", "c r laine furniture", "cr laine furniture"

## Parser

| File | Purpose | Server-only? |
|------|---------|-------------|
| `lib/pricing/crLaineExtractor.ts` | PDF extraction with columnar layout | Yes (uses pdf-parse) |

## Import Endpoint

Uses the shared `api/pricing/import/wholesale-prices.ts` endpoint (same as Wesley Hall). Vendor-specific behavior is driven by `VENDOR_OPTION_SEEDS` and `VENDOR_SURCHARGE_MAP` keyed by the resolved vendor name.

## Grade System

- **Fabric**: Grades 7-25. Combined 7/COM row (grade 7 and COM share the same price).
- **Leather**: COL + grades 7-12 (narrower range than Wesley Hall).
- Grade riser stored per style.

## Options Seeded

| Group | Options |
|-------|---------|
| Cushion Upgrade | Hamilton Spring Down, Comfort Down, Harmony |
| Decorative Finish | Premium Finish |
| Nailhead Trim | Nailhead Trim |
| Welting | Contrast Welt, Contrast Bias Welt |
| Back Fill | Fiber Back, Comfort Down Back, Legacy Down Back, Extra Full Back |

## Surcharge Mapping

| Product Field | Maps To |
|--------------|---------|
| `springDownBdbSurcharge` | Cushion Upgrade / Hamilton Spring Down |
| `comfortDownBdbSurcharge` | Cushion Upgrade / Comfort Down |
| `harmonySurcharge` | Cushion Upgrade / Harmony |
| `decorativeFinishSurcharge` | Decorative Finish / Premium Finish |
| `nailheadSurcharge` | Nailhead Trim |
| `contrastWeltSurcharge` | Welting / Contrast Welt |
| `contrastBiasWeltSurcharge` | Welting / Contrast Bias Welt |
| `fiberBackSurcharge` | Back Fill / Fiber Back |
| `comfortDownBackSurcharge` | Back Fill / Comfort Down Back |

## Known Quirks

- **Columnar PDF layout**: Products are arranged side-by-side on each page, not in a single table. The extractor must handle this multi-column structure.
- **Combined 7/COM row**: Grade 7 and COM share the same price in the price book. The parser must split this into separate grade entries.
- **Server-only**: Uses `pdf-parse`, must not be imported from client-side code.
- **Image extraction**: CR Laine products include page numbers for precise image mapping (unlike Wesley Hall which uses proportional distribution).

## Key Files

- `lib/pricing/crLaineExtractor.ts` -- PDF parser (server-only)
- `pages/api/pricing/import/wholesale-prices.ts` -- shared import endpoint

---
Last verified: 2026-04-07
