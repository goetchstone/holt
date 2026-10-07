// /app/__tests__/wholesaleVendorProfiles.test.ts
//
// Three vendors read by one engine. Every fixture mirrors a real book's LAYOUT;
// every price in it is invented. This repo is public and a vendor's dealer costs
// are confidential -- the layout is what the parser keys on, and the layout is
// what these prove.
//
// What each case is really guarding is a SILENT failure. A price book that
// parses into the wrong tier still imports, still shows a number, and the number
// is plausible. Nothing downstream knows the right answer to compare against, so
// a misread survives until someone quotes a customer from it.

import { parseRenderedGrid } from "@/lib/pricing/wholesale/columnGrid";
import {
  supportedWholesaleVendorIds,
  wholesaleProfileFor,
  WHOLESALE_VENDOR_PROFILES,
} from "@/lib/pricing/wholesale/registry";

const page = (n: number, body: string) => `<<PAGE:${n}>>\n${body}`;

// Letter-laddered fabric book. Two styles side by side.
const SAM_MOORE = page(
  4,
  [
    "STYLE NUMBER:\t1034\t1035",
    "STYLE NAME:\tNova\tOrion",
    "STYLE DESCRIPTION:\tSwivel Chair\tClub Chair",
    'COM\t54" PLAIN COM FABRIC Required (Yds.):\t6 1/2\t7',
    "OVERALL Width:\t31 1/2\t33",
    "OVERALL Depth:\t34\t35",
    "OVERALL Height:\t30\t31",
    "SEAT Height:\t20\t21",
    "Grade: B\t$500\t$540",
    "Grade: C\t$525\t$565",
    "Grade: E and COM\t$575\t$615",
    "Grade: J\t$700\t--",
    "Premium: Prem 1\t$800\t$840",
    "Premium: Prem 2\t$850\t$890",
  ].join("\n"),
);

// Two ladders on one frame: fabric letters plus a true leather grid. Mirrors the
// April 2026 edition's layout: the style label split over `STYLE` / `NUMBER:`,
// a sparse leather-SKU row (only the second style is offered in leather),
// dimensions self-labelled in every cell, and `N/A` for a rung not offered.
const HOOKER = page(
  13,
  [
    "STYLE\t9001-005\t9002-010",
    "NUMBER:\t9002-010-L",
    "STYLE NAME:\tAlder\tBirch",
    "DESCRIPTION:\tSofa\tChair",
    'W  84 1/2"\tW  32"',
    'D  38"\tD  36  1/2"',
    'H  36"\tH  35"',
    "COM Requirements:\t14 Yds\t6  1/2 Yds",
    "Fabric - Grade B \t$1,000\t$400",
    "Fabric - Grade E (COM)\t$1,100\t$450",
    "Fabric - Grade J\t$1,300\t$600",
    "Leather - L1\tN/A\t$900",
    "Leather - L4\tN/A\t$1,100",
    "Leather - NV\tN/A\t$1,200",
    "Leather - NVPR\tN/A\t$1,350",
  ].join("\n"),
);

// Leather-only, and a "/"-joined SKU family sharing one price column. Mirrors
// the July 2026 edition: the suffix line carries NO label and only the family
// column prints one; width and height are self-labelled lines; depth rides in
// OVERALL DIMENSIONS as `D  38"`. The book prints no STYLE NAME row at all.
// (An earlier version of this fixture invented `SUFFIX:` and `STYLE NAME:`
// labels the book never prints -- which is how a suffix bug hid for months.)
const BRADINGTON_YOUNG = page(
  7,
  [
    "ITEM NUMBER:\t770/771/772/773/774\t880",
    "-87",
    "DESCRIPTION:\tRecliner\tChair",
    'W  32"\tW  30"',
    'OVERALL DIMENSIONS:\tD  38"\tD  36 1/2"',
    'H  40"\tH  39"',
    "LEATHER - GRADE 1\t1,000\t900",
    "LEATHER - GRADE 4\t1,300\tN/A",
    "LEATHER - NOVELTY\t1,400\t1,250",
    "LEATHER - NOVELTY PREMIUM\t1,600\t1,450",
  ].join("\n"),
);

const profile = (id: string) => {
  const p = wholesaleProfileFor(id);
  if (!p) throw new Error(`missing profile: ${id}`);
  return p;
};
const gradeMap = (prices: { grade: string; cost: number }[]) =>
  Object.fromEntries(prices.map((g) => [g.grade, g.cost]));

describe("one engine, three books", () => {
  it("reads a letter-laddered fabric book", () => {
    const out = parseRenderedGrid(SAM_MOORE, profile("sam-moore")).data;
    expect(out.map((p) => p.styleNumber)).toEqual(["1034", "1035"]);

    const nova = gradeMap(out[0].gradePrices);
    expect(nova).toMatchObject({ B: 500, C: 525, E: 575, J: 700, "Prem 1": 800, "Prem 2": 850 });

    // "--" is this book's no-price cell, and it must yield no rung rather than 0.
    expect(gradeMap(out[1].gradePrices)).not.toHaveProperty("J");

    // Fractions are real measurements: 31 1/2 is 31.5, not 31.
    expect(out[0].overallWidth).toBe(31.5);
    expect(out[0].yardagePlain).toBe(6.5);
  });

  // The failure this exists for: an importer that guesses material from the
  // SHAPE of a code reads a bare letter as leather. Sam Moore and Hooker both
  // ladder fabric as B..J, so under that guess their whole range files as
  // leather at the wrong tier -- and still imports, and still looks fine.
  it("declares letter grades as FABRIC, never inferring from the code's shape", () => {
    for (const id of ["sam-moore", "hooker"]) {
      const letters = profile(id).grades.filter((g) => /^[A-Z]$/.test(g.code));
      expect(letters.length).toBeGreaterThan(0);
      expect(letters.every((g) => g.kind === "fabric")).toBe(true);
    }
    // And the leather-only book declares the opposite, with no shared heuristic.
    expect(profile("bradington-young").grades.every((g) => g.kind === "leather")).toBe(true);
  });

  it("carries two ladders on one frame, each correctly kinded", () => {
    const out = parseRenderedGrid(HOOKER, profile("hooker")).data;
    expect(out.map((p) => p.styleNumber)).toEqual(["9001-005", "9002-010"]);
    const g = gradeMap(out[1].gradePrices);
    expect(g).toMatchObject({ B: 400, E: 450, J: 600, L1: 900, L4: 1100, NV: 1200, NVPR: 1350 });

    // "N/A" is a rung not offered: the fabric-only style carries no leather.
    expect(Object.keys(gradeMap(out[0].gradePrices)).sort()).toEqual(["B", "COM", "E", "J"]);

    // Leather belongs to this style, not a style of its own.
    expect(profile("hooker").leatherPlacement).toBe("combined");
  });

  it("reads the April 2026 layout: split style label, self-labelled dimensions", () => {
    const [alder, birch] = parseRenderedGrid(HOOKER, profile("hooker")).data;
    expect([alder.styleName, alder.description, birch.styleName]).toEqual([
      "Alder",
      "Sofa",
      "Birch",
    ]);
    // `W  84 1/2"` -- the label is inside the cell, and the fraction is real.
    expect([alder.overallWidth, alder.overallDepth, alder.overallHeight]).toEqual([84.5, 38, 36]);
    // A double space inside the value is still one measurement.
    expect(birch.overallDepth).toBe(36.5);
    expect([alder.yardagePlain, birch.yardagePlain]).toEqual([14, 6.5]);
  });

  // The leather-SKU row prints only for styles offered in leather, and the
  // renderer drops empty cells -- so the one SKU sits in the row's FIRST cell
  // while belonging to the SECOND style. Read by position, the fabric-only sofa
  // would be ordered in leather under another style's number.
  it("gives a leather SKU to the style it names, not to the column it landed in", () => {
    const [alder, birch] = parseRenderedGrid(HOOKER, profile("hooker")).data;
    expect(alder.leatherStyleNumber).toBeNull();
    expect(birch.leatherStyleNumber).toBe("9002-010-L");
  });

  it("gives a leather SKU to the longest style number it extends", () => {
    const grid = page(
      13,
      ["STYLE\t9101\t9101-005", "NUMBER:\t9101-005-L", "Fabric - Grade B\t$100\t$200"].join("\n"),
    );
    const [short, long] = parseRenderedGrid(grid, profile("hooker")).data;
    expect(short.leatherStyleNumber).toBeNull();
    expect(long.leatherStyleNumber).toBe("9101-005-L");
  });

  it("prices COM at its own rung rather than as a second price", () => {
    const out = parseRenderedGrid(SAM_MOORE, profile("sam-moore")).data;
    const g = gradeMap(out[0].gradePrices);
    // The book prints "Grade: E and COM" -- one rung, two names, one number.
    expect(g.COM).toBe(g.E);
  });

  it("splits a slash-joined SKU family into one style per real SKU", () => {
    const out = parseRenderedGrid(BRADINGTON_YOUNG, profile("bradington-young")).data;
    expect(out.map((p) => p.styleNumber)).toEqual([
      "770-87",
      "771-87",
      "772-87",
      "773-87",
      "774-87",
      "880",
    ]);
    // Every SKU in the family carries that column's prices.
    for (const p of out.slice(0, 5)) {
      expect(gradeMap(p.gradePrices)).toMatchObject({ L1: 1000, L4: 1300, NV: 1400, NVPR: 1600 });
    }
    // "N/A" is this book's no-price cell -- a different token from Sam Moore's.
    expect(gradeMap(out[5].gradePrices)).not.toHaveProperty("L4");
  });

  it("reads overall dimensions from W and H lines and a depth-carrying OVERALL DIMENSIONS row", () => {
    const out = parseRenderedGrid(BRADINGTON_YOUNG, profile("bradington-young")).data;
    const chair = out[out.length - 1];
    expect([chair.overallWidth, chair.overallDepth, chair.overallHeight]).toEqual([30, 36.5, 39]);
    expect(out[0].description).toBe("Recliner");
  });

  // "LEATHER - NOVELTY PREMIUM" starts with "LEATHER - NOVELTY". Match the short
  // label first and every premium row silently prices as plain novelty -- one
  // tier low, on the most expensive rung in the book.
  it("matches the longer grade label first", () => {
    const p = profile("bradington-young");
    expect(p.gradeOfRow("LEATHER - NOVELTY PREMIUM")).toBe("NVPR");
    expect(p.gradeOfRow("LEATHER - NOVELTY")).toBe("NV");
    const g = gradeMap(parseRenderedGrid(BRADINGTON_YOUNG, p).data[0].gradePrices);
    expect(g.NVPR).toBe(1600);
    expect(g.NV).toBe(1400);
  });

  // The renderer glues neighbouring cells ("6 Yds 7 Yds") and drops empty ones,
  // so a row can come out with fewer values than there are styles. Read by
  // position, every value after the gap lands one style over -- a real Sam Moore
  // book shifted COM yardage onto three wrong styles that way. The row is left
  // unset for the grid, and the page says so; the aligned rows still read.
  it("leaves a row it cannot place unset, and says so, instead of shifting it", () => {
    const glued = page(
      14,
      [
        "STYLE\t9003\t9004\t9005",
        "STYLE NAME:\tCedar\tDogwood\tElm",
        'W  30"\tW  31"\tW  32"',
        "COM Requirements:\t5 Yds\t6 Yds 7 Yds",
        "Fabric - Grade B\t$400\t$410\t$420",
      ].join("\n"),
    );
    const out = parseRenderedGrid(glued, profile("hooker"));
    expect(out.data.map((p) => p.yardagePlain)).toEqual([null, null, null]);
    expect(out.data.map((p) => p.overallWidth)).toEqual([30, 31, 32]);
    expect(out.stats.rowsMisaligned).toBe(1);
    const warning = out.diagnostics.find((d) => d.level === "warning");
    expect(warning?.message).toMatch(/page 14: yardage did not have one value per style/);
  });

  it("skips a page that has a grid header but no prices, and SAYS so", () => {
    // A schematic-only book used to parse to [] and report success. The empty
    // result is still correct; what changed is that it now carries an error
    // diagnostic naming why -- here, pageRequires dropped the page -- so the
    // route can refuse it and the UI can show the reason.
    const schematic = page(3, ["ITEM NUMBER:\t900", "STYLE NAME:\tDiagram only"].join("\n"));
    const out = parseRenderedGrid(schematic, profile("bradington-young"));
    expect(out.data).toEqual([]);
    expect(out.stats).toMatchObject({ pagesSeen: 1, pagesDropped: 1, grids: 0 });
    expect(out.summary.errorCount).toBe(1);
    expect(out.diagnostics.map((d) => d.level)).toEqual(["error"]);
    expect(out.diagnostics[0].message).toMatch(/dropped by pageRequires/);
  });
});

// Bradington-Young's suffix line has no label, and only FAMILY columns print a
// suffix. Read positionally after dropping a "label", every family took its
// neighbour's suffix: on the real July 2026 book, 487 of 598 family SKUs --
// the part number a dealer orders by -- imported wrong.
describe("Bradington-Young: a family's suffix is the one printed for it", () => {
  const by = () => profile("bradington-young");
  const grid = (lines: string[]) => page(9, lines.join("\n"));
  const skus = (text: string) => parseRenderedGrid(text, by()).data.map((p) => p.styleNumber);

  it("gives each family column its own suffix, from an unlabelled line", () => {
    const text = grid([
      "ITEM NUMBER:\t201/202\t201/202\t201/202",
      "-OT\t-07\t-25SW",
      "LEATHER - GRADE 1\t$100\t$110\t$120",
    ]);
    expect(skus(text)).toEqual(["201-OT", "202-OT", "201-07", "202-07", "201-25SW", "202-25SW"]);
  });

  it("skips single-style columns when handing out suffixes, even with a name glued on", () => {
    const text = grid([
      "ITEM NUMBER:\t880\t301/302\t401/402",
      "WEST HAVEN\t-CO\t-OT",
      "LEATHER - GRADE 1\t$100\t$110\t$120",
    ]);
    expect(skus(text)).toEqual(["880", "301-CO", "302-CO", "401-OT", "402-OT"]);
  });

  it("keeps a family the book prints without any suffix", () => {
    const text = grid(["ITEM NUMBER:\t501/502", "DESCRIPTION:\tSofa", "LEATHER - GRADE 1\t$100"]);
    expect(skus(text)).toEqual(["501", "502"]);
  });

  // The number list continues on the next line, so the item cell is truncated
  // and the suffix is out of reach: any SKU emitted would be incomplete or wrong.
  it("imports nothing for a family whose list wraps, and says so", () => {
    const text = grid([
      "ITEM NUMBER:\t701/702\t880",
      "703/704\tKYLAN",
      "LEATHER - GRADE 1\t$100\t$110",
    ]);
    const out = parseRenderedGrid(text, by());
    expect(out.data.map((p) => p.styleNumber)).toEqual(["880"]);
    expect(out.stats.columnsUnplaceable).toBe(1);
    expect(
      out.diagnostics.some((d) => /page 9: 1 priced column\(s\) not imported/.test(d.message)),
    ).toBe(true);
  });

  it("imports nothing when the suffixes cannot be matched one per family column", () => {
    const text = grid(["ITEM NUMBER:\t201/202\t301/302", "-OT", "LEATHER - GRADE 1\t$100\t$110"]);
    const out = parseRenderedGrid(text, by());
    expect(out.data).toEqual([]);
    expect(out.stats.columnsUnplaceable).toBe(2);
  });
});

describe("the registry", () => {
  it("refuses an unknown vendor instead of guessing a reader", () => {
    expect(wholesaleProfileFor("not-a-vendor")).toBeUndefined();
    expect(supportedWholesaleVendorIds()).toEqual(["bradington-young", "hooker", "sam-moore"]);
  });

  it("holds no duplicate ids, and every profile declares a kind for every grade", () => {
    const ids = WHOLESALE_VENDOR_PROFILES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of WHOLESALE_VENDOR_PROFILES) {
      expect(p.grades.length).toBeGreaterThan(0);
      expect(p.grades.every((g) => g.kind === "fabric" || g.kind === "leather")).toBe(true);
      // A ladder with a repeated code would silently overwrite a tier.
      const codes = p.grades.map((g) => g.code);
      expect(new Set(codes).size).toBe(codes.length);
    }
  });
});

describe("vendor id and vendor name are the same vendor", () => {
  // The upload form posts "sam-moore"; the database holds "Sam Moore". A lookup
  // that only matched one of them would not error -- it would report "no
  // profile", drop back to shape-guessing, and file the fabric ladder as
  // leather. The bug would be a hyphen.
  it("resolves a profile from either spelling", () => {
    for (const spelling of ["sam-moore", "Sam Moore", "SAM MOORE", " sam_moore "]) {
      expect(wholesaleProfileFor(spelling)?.id).toBe("sam-moore");
    }
    expect(wholesaleProfileFor("Bradington-Young")?.id).toBe("bradington-young");
    expect(wholesaleProfileFor("Hooker Custom Upholstery")).toBeUndefined();
  });
});

describe("per-style options come from the book, not a seed table", () => {
  // Options are per STYLE, and the book's own legend says which frames take
  // which. Getting this wrong offers a designer an upcharge the vendor will not
  // build, or hides one they would have sold.
  const OPTIONS = page(
    9,
    [
      "STYLE NUMBER:\t1034\t1035\t1036",
      "STYLE NAME:\tNova\tOrion\tPike",
      "Grade: B\t$500\t$540\t$470",
      "CONTRAST WELT  (B - ZZ fabric)\t$20\t--\tN/C",
      "CONTRAST INSIDE BACK (B - ZZ fabric)\t$30\t$30\t--",
      "WELT ONLY (delete Nails):\tStandard\tStandard\tStandard",
    ].join("\n"),
  );
  const opts = (n: string) => {
    const p = parseRenderedGrid(OPTIONS, profile("sam-moore")).data.find(
      (x) => x.styleNumber === n,
    );
    return Object.fromEntries(
      (
        (
          p as unknown as {
            styleOptions: {
              optionName: string;
              surcharge: number;
              isStandard: boolean;
              isAvailable: boolean;
              requiresTextInput: boolean;
            }[];
          }
        ).styleOptions ?? []
      ).map((o) => [o.optionName, o]),
    );
  };

  it("prices an option only on the frames the book prices it on", () => {
    expect(opts("1034")["Contrast Welt"]).toMatchObject({ surcharge: 20, isAvailable: true });
  });

  // "--" is the book's Not Available token, printed on every page. Kept as a row
  // rather than dropped, so the UI can grey it out with a reason instead of
  // leaving a designer wondering whether it was simply missed.
  it("keeps a not-available option as an explicit no, not a silence", () => {
    expect(opts("1035")["Contrast Welt"]).toMatchObject({ isAvailable: false });
    expect(opts("1036")["Contrast Inside Back"]).toMatchObject({ isAvailable: false });
  });

  // The book prints two different zero-cost words and they mean different
  // things. Collapsing them tells a customer something is fitted when it is
  // merely free to add.
  it("separates standard equipment from a free choice", () => {
    expect(opts("1036")["Contrast Welt"]).toMatchObject({
      surcharge: 0,
      isStandard: false,
      isAvailable: true,
    });
    expect(opts("1034")["Welt Only (delete nails)"]).toMatchObject({
      surcharge: 0,
      isStandard: true,
      isAvailable: true,
    });
  });

  // A contrast option is applied in a different fabric from the body, so the
  // order is not orderable until the designer names it.
  it("flags the options that need the designer to name a fabric", () => {
    expect(opts("1034")["Contrast Welt"].requiresTextInput).toBe(true);
    expect(opts("1034")["Welt Only (delete nails)"].requiresTextInput).toBe(false);
  });
});
