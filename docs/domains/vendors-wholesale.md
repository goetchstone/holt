# Wholesale price books

How a vendor's price book becomes styles and grade prices, and what it takes to
add one.

## The shape of the problem

A furniture manufacturer prints one book layout and puts several brands on it.
Hooker Furnishings prints Hooker, Sam Moore and Bradington-Young on the same
column-transposed grid, so the reusable unit is the **layout**, not the vendor.
A vendor is a set of parameters against a layout.

Before this seam there were three near-identical extractor modules, each with
its own copy of the money parser, the dimension parser and the grid walk — and
the differences between them were four lines each.

## The layout

A page holds several style **columns** side by side. Every row is labelled.
Reading down a column gives one style; reading across a row gives one attribute
for every style on the page.

```
STYLE NUMBER:      1034      1035      1036
STYLE NAME:        Nova      Orion     Pike
Grade: B           $500      $540      $470
Grade: C           $525      $565      $495
```

Raw `pdf-parse` output is unusable here: glyphs butt together with no delimiter,
so `$500$540$470` arrives as one token. `columnAwarePageRenderer` rebuilds the
columns from glyph x-coordinates and inserts real tabs. Every vendor on this
layout must render through it — that is not a preference, the text is otherwise
unparseable.

## Adding a vendor

Three steps. None touches the import route.

1. Write `src/lib/pricing/wholesale/vendors/<vendor>.ts` exporting a
   `WholesaleVendorProfile`.
2. Add it to `WHOLESALE_VENDOR_PROFILES` in `wholesale/registry.ts`.
3. Measure the vendor's books with the coverage script and record them in the
   manifest (see [Coverage](#coverage)). CI enforces this step:
   `wholesaleCoverage.test.ts` fails while a book the new reader accepts is still
   marked `unsupported`.

A profile is **code, not config** — it is compiled, typed and reviewed. That is
deliberate: a config format expressive enough to describe a PDF layout is a
programming language with a worse type checker, which is the road rule 62
exists to close. What a *deployment* configures is which vendors it carries and
what markup it applies. What a *vendor* fixes is its grade ladder and its label
spellings, and those are identical for every dealer who opens the same book.

### What a profile declares

| Field | Why it varies |
|---|---|
| `grades` | The ladder, in book order, each rung declaring `fabric` or `leather` |
| `gridHeader` | The row that starts a style grid (`STYLE NUMBER:` / `ITEM NUMBER:`) |
| `gradeOfRow` | How a price row names its grade — spellings differ per book |
| `rows` | Which labelled rows fill which product field. A row is labelled (values after the first tab), `deep` (a label nested in the row: values after the second tab), or `inline` (the label is inside every cell, `W  30 1/2"`, and is stripped from each) |
| `emptyCells` | This book's "no price" token — `--` on one, `N/A` on another |
| `comGrade` | The rung that is also COM, where the book prints "Grade: E and COM" |
| `pageRequires` | Patterns a page must carry to be a price grid, not a schematic |
| `leatherPlacement` | Whether leather is a tier of the same frame or its own style |
| `expandSkus` | For books where one price column covers several SKUs |
| `layoutText` | For books whose names or descriptions wrap in ways the tab text cannot place: a map from SKU to name and description, read from positioned text (`readPdfTextItems`). When set it is their only source (see "Words read by position") |
| `expect` | What this vendor's book looks like — style count, grade coverage, page range, cover markers — so the wrong edition is refused, not parsed to nothing (see "Edition assertion") |

## Rows the engine will not guess

The renderer turns a PDF page into tab-separated lines, and it is lossy in two
ways a profile cannot see: it **drops empty cells** and it **glues neighbours**
("Wing w/o ButtonsSide Dining Chair"). Positional rows are the ones read by
column: names, descriptions, dimensions, yardage. So a positional row whose cell
count is not the style count cannot be placed. Read anyway, every value after
the gap lands one style over and still looks plausible. Sam Moore's July 2026
book shifted descriptions and COM yardage onto the wrong styles exactly this way
until the engine learned to refuse. Such a row is **left unset for that grid**,
counted in `stats.rowsMisaligned`, and reported as a warning naming the page and
the row. It is never guessed.

A leather-SKU row (`leatherStyleNumber`) is sparse by nature — a SKU prints only
for styles offered in leather — so it is never read by position. Each SKU is
given to the style whose number it extends, the longest such (`1344-005-L` →
`1344-005`, not a sibling `1344`).

A profile's `expandSkus` returns `[]` when a column's SKUs cannot be named
without guessing — a SKU family whose suffix cannot be placed, or whose number
list wraps onto the next line. The engine then imports **nothing** for that
column, counts it in `stats.columnsUnplaceable`, and warns per page. A wrong SKU
orders the wrong product; a missing one is visible and can be added by hand.
→ `app/__tests__/wholesaleVendorProfiles.test.ts`

### Words read by position

The tab renderer keeps a line's order but not where on the line each piece
sat, and it merges runs within 3 pt vertically into one line. A column whose
text wraps can therefore land in the wrong row. Bradington-Young's last name
line was merged into `DESCRIPTION:`, so a name fragment imported as every
style's description on those pages. A profile with `layoutText` gets a second
pass over the PDF's positioned text: `extractWholesaleGrid` calls it and
`applyLayoutText` takes each style's name and description from the map. A
style the map leaves out gets **neither**, rather than the rendered row's
possibly wrong words. It is counted in `stats.layoutUnplaced` with one warning.
→ `app/__tests__/bradingtonYoungLayoutText.test.ts`, `docs/domains/vendors/bradington-young.md`

## Grades are declared, never inferred

This is the part worth understanding before adding a vendor.

The import used to guess a grade's material from the **shape of its code**: a
bare letter meant leather, digits meant fabric, `L`-prefixed meant leather. Then
vendors disagreed, and the guess got patched with allowlists —
`FABRIC_LETTER_GRADE_VENDORS`, `COMBINED_LEATHER_VENDORS` — living in the import
route itself.

Both Sam Moore and Hooker ladder **fabric** as B..J. Under the guess, their
entire fabric range files as leather at the wrong tier. And it still imports.
The numbers still look plausible. Nothing downstream holds the right answer to
compare against, so the error survives until someone quotes a customer from it.

So every rung declares its own `kind`, `partitionGradesFor()` uses the vendor's
declaration verbatim, and there is nothing left to patch. Vendors with no
profile still fall through to the shape rules, which are kept and labelled as a
guess.

## Lookup fails closed

`wholesaleProfileFor()` returns `undefined` for an unknown vendor, and
`lib/pricing/parsePriceBook.ts` — the one dispatcher behind `/api/pricing/parse-pdf`
— turns that into a 400 carrying the supported list. It does not fall back to a
reader that is "probably close". Guessing at a price book produces plausible
numbers at wrong tiers — worse than a rejection, because nobody goes looking
(rule 63).

That sentence was false until 2026-09-17: the route defaulted `vendor` to
`wesley-hall` and parsed any unknown vendor with Wesley Hall's row shapes, which
produced a count of 0 and a green toast. The dispatcher exists so the claim and
the code are the same thing.

It also folds `sam-moore`, `Sam Moore` and `SAM_MOORE` to one key. The upload
form posts the id and the database holds the name; a lookup matching only one
would silently report "no profile" and drop back to guessing. The bug would have
been a hyphen.

## Zero is an error

`parseRenderedGrid()` returns a `ParseResult` (`lib/pricing/pricingTypes.ts`),
not a bare array: `data`, `diagnostics`, `summary`, plus `stats` — pages seen,
pages dropped by `pageRequires`, grids found, style columns dropped for lack of
a recognised grade price. **A parse with zero styles always carries an `error`
diagnostic that says which of those happened**, because each is a different
failure: 40 pages all dropped by `pageRequires` is the wrong book; 40 pages kept
and no grid header is a relabelled style row; 40 grids whose every column dropped
is a renamed grade ladder. The route answers 422 for any error diagnostic and the
UI keeps the user on the upload step with the reasons listed. The legacy
per-vendor readers never throw on a mismatched book either — `parsePriceBook`
attaches a generic error to any zero they return.

## Edition assertion

A profile is written against one edition, and vendors move labels when they
reprint. `expect` on the profile declares what the book should look like, and
`assertEdition()` (run by `extractWholesaleGrid`, exported for tests and the
coverage script) turns each violation into an `error` diagnostic:

| field | fires when |
|---|---|
| `minStyles` | fewer styles parsed than the book has ever had |
| `grades: "all"` / `"some"` | a declared grade code priced nothing / none did |
| `pageCountRange` | the PDF's page count (from pdf-parse) is outside the range |
| `bookMarkers` | a regex — cover title, program name — appears nowhere in the rendered text |

None of them throws; the products that *were* read stay on the result as
evidence. Set `minStyles` and `grades` on every profile; add `pageCountRange`
once the coverage script has measured the book; reach for `bookMarkers` when a
vendor prints two books that counts alone cannot tell apart. Record the edition
each profile was written against in its runbook.
→ `app/__tests__/wholesaleParseResult.test.ts`, `app/__tests__/parsePriceBook.test.ts`

## Coverage

Which books holt can read is a measured number, not a claim. The coverage script
runs every book through the same `parsePriceBook()` the importer uses and checks
each against `app/scripts/wholesale-coverage.expected.json`:

```bash
cd app && npm run pricing:coverage -- --dir ~/pricelists
```

The manifest is exhaustive (rule 65). Every PDF in every `<vendor>/wholesale/`
folder under `--dir` must be claimed by exactly one entry, and each entry states
its expectation: `parsed` with a style count (±10%), or `refused` / `unsupported`
with the reason — usually the VAL package that will fix it. The run exits 1 in
**both** directions: a book that stops parsing or drifts outside its count, and
a PDF nobody has classified. A new edition therefore arrives as a red run, not a
silent gap. When an edition legitimately changes a count, update the entry.

As of 2026-09-23: **14 of 46 books parse, across 11 vendors** (13 / 10 before VAL-01 read Hooker's April 2026 book).

The books are private and never enter the repo. `--dir` points at wherever they
live, the manifest carries counts only, and the script refuses to write any file
inside the repository (`--out` for a JSON report, `--render` below).

**Authoring a profile:** `--render <book.pdf> --out <file> [--page N]` writes the
column-aware text a profile is matched against, the same rendering
`extractWholesaleGrid` sees.

CI has no books, so it runs the other half, which needs none:
`wholesaleCoverage.test.ts` checks the manifest against the code. A book may be
marked parsed only where a reader exists, and may not stay `unsupported` once a
reader accepts it.
→ `app/scripts/wholesale-coverage.impl.ts`, `app/__tests__/wholesaleCoverage.test.ts`

## Testing

Drive `parseRenderedGrid()` with a text fixture, never a PDF — a fixture is
readable in a diff. **Every price in a fixture is invented.** This repo is
public and a vendor's dealer costs are confidential; the layout is what the
parser keys on and the layout is what a fixture needs to reproduce.
→ `app/__tests__/wholesaleVendorProfiles.test.ts`
