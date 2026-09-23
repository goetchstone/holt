# Bradington-Young

Leather upholstery, motion and stationary. Leather only: six rungs (Grade 1–4,
Novelty, Novelty Premium), no fabric ladder.

**Pricing model**: grade grid (wholesale column-grid engine)
**Profile**: `lib/pricing/wholesale/vendors/bradingtonYoung.ts` (`id: "bradington-young"`)
**Name match**: "bradington" — matches "Bradington Young" and "Bradington-Young"

## Edition

Written against the **July 2026** wholesale price list: 107 pages. The
promotional program books (SMP, Sensible Seating, Luxury Motion) are separate
books with their own reader (VAL-02); the coverage manifest records them as
`unsupported` until it lands.

## SKU families and suffixes

One price column can cover several SKUs that share a frame and a price: the
item cell reads `770/771/772/773/774` and a suffix on the next line, `-87`,
completes each (`770-87` … `774-87`).

That suffix line carries **no label**, and **only family columns print one** —
single-style columns hold their whole SKU in the item cell. The renderer may
also glue a style name onto the same line (`WEST HAVEN  -CO  -OT`). So the
suffixes are that line's `-XX` cells in order, one per family column in order.

A column is **not imported** — counted in `stats.columnsUnplaceable` and
reported — when:

- the suffix count doesn't match the family-column count, or
- the family's number list wraps onto the next line (the item cell is
  truncated, so both the SKUs and the suffix are out of reach).

A wrong SKU orders the wrong product, so these are refused rather than guessed.

**History:** until 2026-09-23 the suffix line was read by position after
dropping its first cell as a label. On this book that gave **487 of 598 family
SKUs a neighbour's suffix or none**. It had passed its tests because the fixture
invented a `SUFFIX:` label the book never prints.

## Layout

| Row | Form in the July 2026 book |
|---|---|
| SKUs | `ITEM NUMBER:` — the grid header |
| Suffixes | the next line, unlabelled (see above) |
| Description | `DESCRIPTION:` — often wraps; only its first line is placeable |
| Width / height | self-labelled lines: `W  84"`, `H  40"` (`inline` rows) |
| Depth | inside `OVERALL DIMENSIONS:` as `D  38"`; sectionals print "DIMENSIONS PER STYLE" there, which yields no number |
| Seat / arm | `SEAT DEPTH:`, `SEAT HEIGHT:`, `ARM HEIGHT:` — often sparse, so often left unset |
| Grades | `LEATHER - GRADE 1` … `4`, `LEATHER - NOVELTY`, `LEATHER - NOVELTY PREMIUM` |
| Not offered | `N/A`, `--` |

**Style names are not read.** The book prints no `STYLE NAME` row; names are
unlabelled text wrapped across lines, which the tab renderer cannot assign to
columns. That waits on positioned text extraction (PLAN VAL-02b(b) after
VAL-06a). Guessing from the wrapped text would import names that look right and
belong to the wrong style.

## Measured

`npm run pricing:coverage -- --dir <books>` → `bradington-young: parsed 771`
(833 before the suffix fix; the difference is 28 unplaceable columns, 62 SKUs).
703 SKUs carry a suffix, 0 duplicates; overall dimensions on about a third of
styles; names 0% (see above). Prices are never recorded here.

## Key files

- `lib/pricing/wholesale/vendors/bradingtonYoung.ts` — the profile, `expandSkus`
- `lib/pricing/wholesale/columnGrid.ts` — the engine
- `app/__tests__/wholesaleVendorProfiles.test.ts` — layout fixture (every price invented)
