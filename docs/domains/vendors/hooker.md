# Hooker Custom Upholstery

Upholstered frames on two ladders: letter-graded fabric (B–J, E is COM) and a
true leather grid (L1–L4, Novelty, Novelty Premium). Both ladders price the
same frame.

**Pricing model**: grade grid (wholesale column-grid engine)
**Profile**: `lib/pricing/wholesale/vendors/hooker.ts` (`id: "hooker"`)
**Name match**: "hooker" — the database vendor row reads "Hooker Furniture", not
the book's title

## Edition

Written against the **April 2026 Stocking Dealer** price list: 45 pages, of
which 19 carry style grids, 94 styles. The profile's `expect` block refuses a
book with fewer than 60 styles, a grade rung that prices nothing, or no
"Custom Upholstery" marker, so a reprint that moves the labels arrives as a
refusal with a reason, not as an empty import.

Hooker's **casegoods** price list is a different book — a flat line list, not a
grid — and this profile does not read it (VAL-07).

## Layout

| Row | Form in the April 2026 book |
|---|---|
| Style numbers | `STYLE` — the grid header; `STYLE NAME:` shares the word but not the tab |
| Leather SKUs | `NUMBER:` on the next line, **sparse**: only styles offered in leather. Matched to styles by number, never by position (see the engine runbook) |
| Name / description | `STYLE NAME:`, `DESCRIPTION:` |
| Overall W / D / H | **Self-labelled in every cell**: `W  30 1/2"` — `inline` rows |
| COM yardage | `COM Requirements:` — sometimes sparse; a grid where it is, leaves yardage unset and says so |
| Seat / arm | `SEAT Depth (in.):`, `SEAT Height (in.):`, `ARM Height (in.):` |
| Fabric grades | `Fabric - Grade B` … `Fabric - Grade E (COM)` … `Grade J` |
| Leather grades | `Leather - L1` … `L4`, `Leather - NV`, `Leather - NVPR` |
| Not offered | `N/A` (and `--`) |

## Measured

`npm run pricing:coverage -- --dir <books>` → `hooker-upholstery: parsed 94`.
On that book every style carries overall dimensions and a name; COM yardage is
unset in the five grids whose row is sparse; about six styles in seven carry a
leather SKU. Prices are never recorded here.

## Known quirks

- The earlier edition used a single `STYLE NUMBER:` header and `OVERALL Width`
  rows. The April 2026 book kept none of it. The coverage gate showed the old
  profile refusing it ("no line matched `/STYLE NUMBER:\t/`") before VAL-01
  rewrote it.
- Note lines that start like grade rows ("Leathers in PURPLE indicate grade
  changes…", "Fabric- 2 20" throw") must not match `gradeOfRow`, and don't.

## Key files

- `lib/pricing/wholesale/vendors/hooker.ts` — the profile
- `lib/pricing/wholesale/columnGrid.ts` — the engine
- `app/__tests__/wholesaleVendorProfiles.test.ts` — layout fixture (every price invented)
