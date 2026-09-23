// /app/__tests__/wholesaleParseResult.test.ts
//
// The wholesale engine used to return a bare array. A wrong-edition book --
// labels moved, grade ladder renamed, the retail copy instead of the dealer
// copy -- parsed to [] and the route reported success. Now every parse is a
// ParseResult whose zero is explained, and a profile can declare what its
// book looks like so a mismatch is refused with a reason.
//
// Both directions, for each rule: the violation produces exactly the error
// it should, and the satisfied case produces none. A guard that only fires is
// half a guard.
//
// Prices are invented (docs/domains/vendors-wholesale.md: fixtures never carry
// a real dealer cost).

import { assertEdition, parseRenderedGrid } from "@/lib/pricing/wholesale/columnGrid";
import type { WholesaleVendorProfile } from "@/lib/pricing/wholesale/profile";
import { wholesaleProfileFor } from "@/lib/pricing/wholesale/registry";

const page = (n: number, body: string) => `<<PAGE:${n}>>\n${body}`;

const samMoore = (): WholesaleVendorProfile => {
  const p = wholesaleProfileFor("sam-moore");
  if (!p) throw new Error("fixture expects the sam-moore profile");
  return p;
};

const GRID = page(
  4,
  [
    "STYLE NUMBER:\t1034\t1035",
    "STYLE NAME:\tNova\tOrion",
    "Grade: B\t$500\t$540",
    "Grade: C\t$525\t$565",
    "Grade: E and COM\t$575\t$615",
  ].join("\n"),
);

const errorsOf = (r: { diagnostics: { level: string; message: string }[] }) =>
  r.diagnostics.filter((d) => d.level === "error").map((d) => d.message);

describe("parseRenderedGrid explains its zeros", () => {
  it("a good grid: styles, no errors, honest counts", () => {
    const out = parseRenderedGrid(GRID, samMoore());
    expect(out.data.map((p) => p.styleNumber)).toEqual(["1034", "1035"]);
    expect(errorsOf(out)).toEqual([]);
    expect(out.stats).toEqual({
      pagesSeen: 1,
      pagesDropped: 0,
      pagesWithGrids: 1,
      grids: 1,
      columnsDropped: 0,
      rowsMisaligned: 0,
      columnsUnplaceable: 0,
    });
    expect(out.summary).toMatchObject({ successCount: 2, errorCount: 0 });
  });

  it("no pages at all is its own error", () => {
    const out = parseRenderedGrid("", samMoore());
    expect(out.data).toEqual([]);
    expect(errorsOf(out)).toEqual([expect.stringMatching(/rendered to no pages/)]);
  });

  it("pages but no grid header names the header it looked for", () => {
    // A retail copy, say: same vendor, every label reworded.
    const out = parseRenderedGrid(page(1, "ITEM\t1034\nRETAIL B\t$999"), samMoore());
    expect(out.data).toEqual([]);
    expect(out.stats).toMatchObject({ pagesSeen: 1, grids: 0 });
    expect(errorsOf(out)).toEqual([expect.stringMatching(/0 grids on 1 page.*grid header/)]);
  });

  it("a grid whose every column has no recognised grade is reported as a ladder change", () => {
    // Header matched, but the grade rows are labelled in a way gradeOfRow
    // does not know -- the signature of a new edition.
    const out = parseRenderedGrid(
      page(
        2,
        ["STYLE NUMBER:\t1034", "STYLE NAME:\tNova", "Tier 1\t$500", "Tier 2\t$525"].join("\n"),
      ),
      samMoore(),
    );
    expect(out.data).toEqual([]);
    expect(out.stats).toMatchObject({ grids: 1, columnsDropped: 1 });
    expect(out.diagnostics.map((d) => d.level)).toEqual(["warning", "error"]);
    expect(errorsOf(out)).toEqual([
      expect.stringMatching(/every style column dropped.*new edition/),
    ]);
  });

  it("a partially-bad grid keeps the good columns and warns about the rest", () => {
    const out = parseRenderedGrid(
      page(
        5,
        ["STYLE NUMBER:\t1034\t--\t9999", "STYLE NAME:\tNova\t\tGhost", "Grade: B\t$500\t\t"].join(
          "\n",
        ),
      ),
      samMoore(),
    );
    expect(out.data.map((p) => p.styleNumber)).toEqual(["1034"]);
    // "--" is an emptyCells value and is skipped silently; 9999 had a header
    // and no price, which is the one that gets counted.
    expect(out.stats.columnsDropped).toBe(1);
    expect(out.diagnostics).toEqual([
      expect.objectContaining({
        level: "warning",
        row: 5,
        message: expect.stringMatching(/1 style column/),
      }),
    ]);
    expect(errorsOf(out)).toEqual([]);
  });
});

describe("assertEdition", () => {
  const withExpect = (expect: WholesaleVendorProfile["expect"]): WholesaleVendorProfile => ({
    ...samMoore(),
    expect,
  });
  const parsed = () => parseRenderedGrid(GRID, samMoore());

  it("no expect block: the result passes through untouched", () => {
    const before = parsed();
    const after = assertEdition(before, samMoore(), { text: GRID });
    expect(after).toBe(before);
  });

  it("minStyles: fails below, passes at", () => {
    const fail = assertEdition(parsed(), withExpect({ minStyles: 3 }), { text: GRID });
    expect(errorsOf(fail)).toEqual(["expected >= 3 styles for Sam Moore, got 2"]);
    expect(fail.summary.errorCount).toBe(1);

    const pass = assertEdition(parsed(), withExpect({ minStyles: 2 }), { text: GRID });
    expect(errorsOf(pass)).toEqual([]);
  });

  it("grades: 'all' fails when a declared grade priced nothing; 'some' passes for the same book", () => {
    // The fixture prices B, C and E only; the profile declares a longer ladder.
    const all = assertEdition(parsed(), withExpect({ grades: "all" }), { text: GRID });
    expect(errorsOf(all)).toEqual([
      expect.stringMatching(/grade ladder mismatch: \d+ of \d+ declared grades priced nothing/),
    ]);

    const some = assertEdition(parsed(), withExpect({ grades: "some" }), { text: GRID });
    expect(errorsOf(some)).toEqual([]);
  });

  it("grades: 'some' fails only when nothing declared priced anything", () => {
    const empty = parseRenderedGrid(page(1, "STYLE NUMBER:\t1\nTier 1\t$5"), samMoore());
    const out = assertEdition(empty, withExpect({ grades: "some" }), { text: "" });
    expect(errorsOf(out)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/none of the \d+ declared grades priced anything/),
      ]),
    );
  });

  it("pageCountRange: inclusive, and skipped when there is no PDF meta", () => {
    const p = withExpect({ pageCountRange: [40, 60] });
    expect(errorsOf(assertEdition(parsed(), p, { text: GRID, meta: { numpages: 39 } }))).toEqual([
      "page count 39 is outside the 40-60 this profile was written against",
    ]);
    expect(errorsOf(assertEdition(parsed(), p, { text: GRID, meta: { numpages: 40 } }))).toEqual(
      [],
    );
    expect(errorsOf(assertEdition(parsed(), p, { text: GRID, meta: { numpages: 60 } }))).toEqual(
      [],
    );
    expect(
      errorsOf(assertEdition(parsed(), p, { text: GRID, meta: { numpages: 61 } })),
    ).toHaveLength(1);
    // A text fixture has no page count; the rule cannot fire on what it cannot see.
    expect(errorsOf(assertEdition(parsed(), p, { text: GRID }))).toEqual([]);
  });

  it("bookMarkers: every marker must appear somewhere in the rendered text", () => {
    const p = withExpect({ bookMarkers: [/STYLE NUMBER/, /Stocking Dealer Price List/i] });
    const out = assertEdition(parsed(), p, { text: GRID });
    expect(errorsOf(out)).toEqual([
      expect.stringMatching(/Stocking Dealer Price List.*not found anywhere/),
    ]);
    const ok = assertEdition(parsed(), p, { text: GRID + "\nSTOCKING DEALER PRICE LIST 2026" });
    expect(errorsOf(ok)).toEqual([]);
  });

  it("violations accumulate; none of them throws", () => {
    const p = withExpect({ minStyles: 10, grades: "all", bookMarkers: [/nowhere/] });
    const out = assertEdition(parsed(), p, { text: GRID, meta: { numpages: 1 } });
    expect(errorsOf(out)).toHaveLength(3);
    expect(out.summary.errorCount).toBe(3);
    // The products are still there for whoever wants to look at what WAS read.
    expect(out.data).toHaveLength(2);
  });
});
