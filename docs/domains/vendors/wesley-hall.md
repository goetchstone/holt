# Wesley Hall

Primary upholstery vendor. Three product lines: Wholesale (main), Foundations (entry-level), and Signature Elements (build-your-own).

**Pricing model**: GRADE_BASED
**the POS name**: "Wesley Hall"
**Alias key**: "wesley hall"

## Parser Files

| File | Purpose | Server-only? |
|------|---------|-------------|
| `lib/pricing/wesleyHallParser.ts` | Main parser: `parseWholesaleRows()`, `parseFoundationsRows()`, `parseFabricRows()`, `detectColumns()` | No (imported by client) |
| `lib/pricing/seParser.ts` | Signature Elements PDF parser | Yes (uses pdf-parse) |

## Import Endpoints

| Endpoint | Product Line | What It Creates |
|----------|-------------|-----------------|
| `api/pricing/import/wholesale-prices.ts` | Wholesale | VendorStyles, Products, grade prices, option overrides |
| `api/pricing/import/foundations.ts` | Foundations | VendorStyles with flat pricing |
| `api/pricing/import/signature-elements.ts` | Signature Elements | Synthetic VendorStyles, SE components |
| `api/pricing/import/fabrics.ts` | All | FabricCatalog entries |

## Grade System

- **Fabric**: Numeric grades 14-35 (typical range). Auto-extends to 60. COM = grade 0.
- **Leather**: Letter grades C-Z. COL = grade 0.
- Detection: numeric grades = fabric dimension, letter grades = leather dimension.
- Grade riser stored per style for extrapolation.

## Options Seeded (VENDOR_OPTION_SEEDS)

| Group | Options |
|-------|---------|
| Decorative Trim | Rope Welt, Brush Fringe, Decorative Tape, Contrast Welt, Contrast Leather Welt |
| Leather Treatment | Bridle Banding, Luxe Bridle Banding |
| Skirt Options | Fabric Banding (Sofa/Loveseat/Chair) |
| Special Features | Ring Base Swivel, Castors, Air Mattress Upgrade, Arm Guards |
| Pillow Upgrades | Pleated Corner, Bordered, Flange, Ruching |
| Nailhead Trim | Generic with text input |
| Wood Finish | 25 traditional (no charge), 4 decorative ($100 each: Champagne, Greystone, Java, Sandalwood) |

## Surcharge Mapping (VENDOR_SURCHARGE_MAP)

| Product Field | Maps To |
|--------------|---------|
| `springDownBdbSurcharge` | Cushion Upgrade / Spring-Down / BDB |
| `comfortDownBdbSurcharge` | Cushion Upgrade / Comfort Down / BDB |
| `cdcSeatBdbBackSurcharge` | Cushion Upgrade / CDC Seat / BDB Back |
| `nailheadSurcharge` | Nailhead Trim |
| `armGuardSurcharge` | Special Features / Arm Guards |
| `ringBaseSwivelSurcharge` | Special Features / Ring Base Swivel |
| `castorSurcharge` | Special Features / Castors |

## Signature Elements (SE) System

Wesley Hall's build-your-own furniture system. Each SE style is a synthetic VendorStyle generated from pricing tables.

### Style Naming Convention

`SE-{material}{depth}-{pieceCode}`

| Part | Values | Meaning |
|------|--------|---------|
| Material | `F` / `L` | Fabric / Leather |
| Depth | `21` / `24` / `CH` | Standard 21" / Extended 24" / Chairs & Ottomans |
| Piece Code | `XLS`, `LGS`, `MDS`, etc. | XL Sofa, Large Sofa, Medium Sofa, etc. |

Full piece codes: XLS, LGS, MDS, APS, LVS, CRS, OAS, ARS, OAL, ARL, CRV, CCH, CHS, ACH, SOT, C15, CMO, CHR, MOT, FSL, QSL

### SE Components (Prisma: SEComponent)

Stored in the database, seeded by the import endpoint. Component types:

| Type | Examples | Notes |
|------|----------|-------|
| DEPTH | Standard (21"), Extended (24") | |
| BASE | Tapered Leg, Turned Leg, Bun Foot, Skirted, Plinth, Block, Metal, Swivel | |
| ARM | English, Track, Slope, Flared, Key, Sock, Tuxedo, Pleated, Scoop | |
| BACK_TYPE | Tight, Filled, Loose, Channeled, Tufted, Shelter | |
| CUSHION_FILL | Ultra Crown (standard), Comfort Down, Spring Down | |
| CASTOR | No Castors, Casters (with pricing) | |

Unique constraint: `(vendorId, componentType, code)`. Some components are `notAvailableInLeather` or `notAvailableOnSleepers`.

### SE Configurator UI

`components/pricing/SEConfigurator.tsx` -- multi-step wizard: Build (select components) -> Grade -> Fabric -> Summary. Reuses the existing `GradePriceGrid` and `calculatePrice` infrastructure. Both admin and designer versions exist; designer passes `retailOnly` to hide wholesale costs.

### SE PDF Parsing

The SE price book is column-oriented (piece types as columns, grades as rows). `seParser.ts` transposes this into row-oriented product records. Each combination of material x depth x piece type generates one synthetic VendorStyle.

## Known Quirks

- `wesleyHallParser.ts` is imported client-side. Any function needing `pdf-parse` must be in `seParser.ts` instead.
- `detectColumns()` uses alias matching to auto-detect CSV column mappings -- handles inconsistent headers.
- Decorative finish surcharge is always $100 for SE products (hardcoded in parser).
- Grade auto-extension can create tiers up to 60 for fabric and Z for leather during import.

## Key Files

- `lib/pricing/wesleyHallParser.ts` -- main parser (client-safe)
- `lib/pricing/seParser.ts` -- SE parser (server-only)
- `pages/api/pricing/import/wholesale-prices.ts` -- wholesale import + option seeds
- `pages/api/pricing/import/signature-elements.ts` -- SE import + component seeding
- `pages/api/pricing/import/foundations.ts` -- foundations import
- `components/pricing/SEConfigurator.tsx` -- SE UI wizard

## Test Coverage

`wesleyHallParser.test.ts` (389 lines) -- well covered.

---
Last verified: 2026-04-07
