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

// Two ladders on one frame: fabric letters plus a true leather grid.
const HOOKER = page(
  13,
  [
    "STYLE NUMBER:\t1344-005",
    "STYLE NAME:\tPercy",
    "OVERALL Width:\t30 1/2",
    "Fabric - Grade B:\t$400",
    "Fabric - Grade E (COM):\t$450",
    "Fabric - Grade J:\t$600",
    "Leather - L1:\t$900",
    "Leather - L4:\t$1,100",
    "Leather - NV:\t$1,200",
    "Leather - NVPR:\t$1,350",
  ].join("\n"),
);

// Leather-only, and a "/"-joined SKU family sharing one price column.
const BRADINGTON_YOUNG = page(
  7,
  [
    "ITEM NUMBER:\t770/771/772/773/774\t880",
    "SUFFIX:\t-87\t",
    "STYLE NAME:\tMadison\tHalstead",
    "OVERALL Width:\t32\t30",
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
    const out = parseRenderedGrid(SAM_MOORE, profile("sam-moore"));
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
    const out = parseRenderedGrid(HOOKER, profile("hooker"));
    expect(out).toHaveLength(1);
    const g = gradeMap(out[0].gradePrices);
    expect(g).toMatchObject({ B: 400, E: 450, J: 600, L1: 900, L4: 1100, NV: 1200, NVPR: 1350 });

    // Leather belongs to this style, not a style of its own.
    expect(profile("hooker").leatherPlacement).toBe("combined");
  });

  it("prices COM at its own rung rather than as a second price", () => {
    const out = parseRenderedGrid(SAM_MOORE, profile("sam-moore"));
    const g = gradeMap(out[0].gradePrices);
    // The book prints "Grade: E and COM" -- one rung, two names, one number.
    expect(g.COM).toBe(g.E);
  });

  it("splits a slash-joined SKU family into one style per real SKU", () => {
    const out = parseRenderedGrid(BRADINGTON_YOUNG, profile("bradington-young"));
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

  // "LEATHER - NOVELTY PREMIUM" starts with "LEATHER - NOVELTY". Match the short
  // label first and every premium row silently prices as plain novelty -- one
  // tier low, on the most expensive rung in the book.
  it("matches the longer grade label first", () => {
    const p = profile("bradington-young");
    expect(p.gradeOfRow("LEATHER - NOVELTY PREMIUM")).toBe("NVPR");
    expect(p.gradeOfRow("LEATHER - NOVELTY")).toBe("NV");
    const g = gradeMap(parseRenderedGrid(BRADINGTON_YOUNG, p)[0].gradePrices);
    expect(g.NVPR).toBe(1600);
    expect(g.NV).toBe(1400);
  });

  it("skips a page that has a grid header but no prices", () => {
    const schematic = page(3, ["ITEM NUMBER:\t900", "STYLE NAME:\tDiagram only"].join("\n"));
    expect(parseRenderedGrid(schematic, profile("bradington-young"))).toEqual([]);
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
  // Options are per STYLE. A frame that cannot take one must not appear to take
  // it for free -- that is the difference between an accurate import and a
  // plausible one, and it decides what a designer can actually order.
  const OPTIONS = page(
    9,
    [
      "STYLE NUMBER:\t1034\t1035\t1036",
      "STYLE NAME:\tNova\tOrion\tPike",
      "Grade: B\t$500\t$540\t$470",
      "CONTRAST WELT  (B - ZZ fabric)\t$20\t--\tN/C",
      "CONTRAST INSIDE BACK (B - ZZ fabric)\t$30\t$30\t--",
      "WELT ONLY (delete Nails):\tStandard\tStandard\tStandard",
      "STANDARD TRIM & AVAILABLE OPTIONSCONTRAST TOP ARM or PANEL (B - ZZ fabric)\t$45\t--\t--",
    ].join("\n"),
  );
  const opts = (n: string) => {
    const p = parseRenderedGrid(OPTIONS, profile("sam-moore")).find((x) => x.styleNumber === n);
    return Object.fromEntries(
      (
        (
          p as unknown as {
            styleOptions: { optionName: string; surcharge: number; isStandard: boolean }[];
          }
        ).styleOptions ?? []
      ).map((o) => [o.optionName, o]),
    );
  };

  it("prices an option only on the frames the book prices it on", () => {
    expect(opts("1034")["Contrast Welt"].surcharge).toBe(20);
    // "--" is the book's own Not Available token, printed on every page.
    expect(opts("1035")["Contrast Welt"]).toBeUndefined();
    expect(opts("1036")["Inside Back Cushion"]).toBeUndefined();
  });

  it("distinguishes included-at-no-charge from not-available", () => {
    // N/C means the frame HAS it, free. Absent means it cannot have it at all.
    // Collapsing the two would offer a designer an option the vendor will not build.
    const free = opts("1036")["Contrast Welt"];
    expect(free).toMatchObject({ surcharge: 0, isStandard: true });
    expect(opts("1036")["Contrast Welt"]).not.toBeUndefined();
  });

  // The book writes "Standard" where other rows write "N/C". Reading only "N/C"
  // dropped this option from all 97 styles that carry it, and the loss looked
  // like the option being rare rather than a token we did not know.
  it("reads every word this book uses for included", () => {
    for (const s of ["1034", "1035", "1036"]) {
      expect(opts(s)["Welt Only (delete nails)"]).toMatchObject({ surcharge: 0, isStandard: true });
    }
  });

  // The renderer glues a section heading onto the next label. An anchored
  // pattern then misses exactly the rows following a heading, and the miss reads
  // as the option being rare -- it cost 66 of 86 pages before this was stripped.
  it("still matches a row whose label carries a glued section heading", () => {
    expect(opts("1034")["Top Arm or Panel"].surcharge).toBe(45);
  });

  // One option, two spellings across the book's pages.
  it("matches both spellings the book uses for one option", () => {
    const p = profile("sam-moore");
    const spec = (p.options ?? []).find((o) => o.optionName === "Inside Back Cushion")!;
    expect(spec.match.test("CONTRAST INSIDE BACK CUSHION (B - ZZ fabric)")).toBe(true);
    expect(spec.match.test("CONTRAST INSIDE BACK (B - ZZ fabric)")).toBe(true);
  });
});
