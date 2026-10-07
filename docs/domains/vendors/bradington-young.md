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
| Names | unlabelled, under the SKUs — read by position (below) |
| Description | `DESCRIPTION:` — wraps; read by position (below) |
| Width / height | self-labelled lines: `W  84"`, `H  40"` (`inline` rows) |
| Depth | inside `OVERALL DIMENSIONS:` as `D  38"`; sectionals print "DIMENSIONS PER STYLE" there, which yields no number |
| Seat / arm | `SEAT DEPTH:`, `SEAT HEIGHT:`, `ARM HEIGHT:` — often sparse, so often left unset |
| Grades | `LEATHER - GRADE 1` … `4`, `LEATHER - NOVELTY`, `LEATHER - NOVELTY PREMIUM` |
| Not offered | `N/A`, `--` |

## Names and descriptions, by position

The book prints no `STYLE NAME` row. A column's name is unlabelled text under
its item number, and its description wraps under `DESCRIPTION:`. The tab
renderer cannot say which column a wrapped line belongs to. On pages where a
family's names run three lines deep, it merged the last name into the
`DESCRIPTION:` row, so **every style on those pages imported a name fragment as
its description**, and no style had a name (found 2026-09-23).

So the profile's `layoutText` reads both from positioned text
(`readPdfTextItems`) and is their only source. Under each `ITEM NUMBER:` row,
each word goes to the item column it is centred under, within half the ~66 pt
column pitch. Then, top to bottom:

- **Family columns** (`201/202/203`): the suffix, then the names. A line
  ending in `/` continues onto the next, and the list ends at the first line
  without one. There is one name per SKU, in family order. The first name line
  sits more than 1.5 lines (7.68 pt leading) above the `DESCRIPTION:` label.
- **Single-style columns**: one line at name height, then the description.
- **Description**: everything after the names, down to the next row label
  (`PROGRAM:`), joined.

Row labels are centred in their rows, so a description can sit a full line
*above* its label. That is why "name height" is 1.5 lines, not "above the
label".

A column is left out, and its styles import with **no name and no
description** (counted in `stats.layoutUnplaced`, one warning), when:

- a family's name count differs from its SKU count. This is also what refuses
  a name broken mid-word, `MARLEIGH/MANNIN` + `G/MALLORY`;
- a single style has two lines at name height (a wrapped name, or a
  description printed high);
- there is no description, or the family's numbers wrap;
- a SKU is printed twice with different words.

Not detectable: a break inside a family's **last** name keeps the count. In
the July 2026 edition every family ends on a whole name followed by its
description (measured).

## Measured

`npm run pricing:coverage -- --dir <books>` → `bradington-young: parsed 771`
(833 before the suffix fix; the difference is 28 unplaceable columns, 62 SKUs).
703 SKUs carry a suffix, 0 duplicates; overall dimensions on about a third of
styles. **Names: 770 of 771** (was 0), each with its description; the one left
out has two lines at name height. No name contains a description word, and no
named style lacks a description. Prices are never recorded here.

## Key files

- `lib/pricing/wholesale/vendors/bradingtonYoung.ts` — the profile, `expandSkus`, `layoutText`
- `lib/pricing/wholesale/columnGrid.ts` — the engine
- `app/__tests__/wholesaleVendorProfiles.test.ts` — layout fixture (every price invented)
- `app/__tests__/bradingtonYoungLayoutText.test.ts` — names and descriptions by position, the page 11 and page 68 geometry, and a hand-built PDF end to end (every word invented)
