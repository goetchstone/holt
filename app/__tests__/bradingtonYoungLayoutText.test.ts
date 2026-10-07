// /app/__tests__/bradingtonYoungLayoutText.test.ts
//
// VAL-02b(b): Bradington-Young names and descriptions are read by position.
// The book prints no STYLE NAME row. A family's names wrap under its item
// number, one per SKU in order, and the tab renderer merged the last name line
// into the DESCRIPTION row -- so every style on such a page imported a name
// fragment as its description, and no style had a name.
//
// Geometry is copied from the July 2026 edition (pages 11 and 68: 6.24 pt type
// on 7.68 pt leading, labels centred in their rows). Every word, SKU and price
// here is invented.

import type { PdfTextItem } from "@/lib/pricing/pdfUtils";
import {
  applyLayoutText,
  extractWholesaleGrid,
  parseRenderedGrid,
} from "@/lib/pricing/wholesale/columnGrid";
import { bradingtonYoung } from "@/lib/pricing/wholesale/vendors/bradingtonYoung";
import { minimalPdf, type Run } from "./helpers/minimalPdf";

const readLayout = bradingtonYoung.layoutText!;

// Header at y 672; family column A centred on x 200, single column B on 266.
const H = 672;
const D = 641.26; // the DESCRIPTION: label, as on page 11
const LABELS: Run[] = [
  { x: 75, y: H, s: "ITEM NUMBER:" },
  { x: 75, y: D, s: "DESCRIPTION:" },
  { x: 75, y: 610.54, s: "PROGRAM:" },
];

/** Runs as readPdfTextItems returns them, with a width so each is centred at `centre`. */
function items(runs: { centre: number; y: number; s: string }[], page = 1): PdfTextItem[] {
  const labels = LABELS.map((l) => ({ x: l.x, y: l.y, w: 45, s: l.s, page }));
  return [...labels, ...runs.map((r) => ({ x: r.centre - 20, y: r.y, w: 40, s: r.s, page }))];
}

const FAMILY = [
  { centre: 200, y: H, s: "901/902/903" },
  { centre: 200, y: 664.78, s: "-AB" },
  { centre: 200, y: 657.1, s: "Alder/" },
  { centre: 200, y: 649.42, s: "Birch /" },
  { centre: 200, y: 641.74, s: "Cedar" }, // the last name, level with DESCRIPTION:
  { centre: 200, y: 633.58, s: "OTTOMAN" },
];
const SINGLE = [
  { centre: 266, y: H, s: "910-17" },
  { centre: 266, y: 664.3, s: "Spruce" },
  { centre: 266, y: 641.36, s: "SWIVEL" },
  { centre: 266, y: 633.58, s: "CHAIR" },
];

describe("Bradington-Young layoutText", () => {
  it("gives each SKU of a family its own name, in order, and the words below as description", () => {
    const out = readLayout(items([...FAMILY, ...SINGLE]));
    expect(out.get("901-AB")).toEqual({ name: "Alder", description: "OTTOMAN" });
    expect(out.get("902-AB")).toEqual({ name: "Birch", description: "OTTOMAN" });
    expect(out.get("903-AB")).toEqual({ name: "Cedar", description: "OTTOMAN" });
  });

  it("reads a single style's name and joins its wrapped description", () => {
    const out = readLayout(items(SINGLE));
    expect(out.get("910-17")).toEqual({ name: "Spruce", description: "SWIVEL CHAIR" });
  });

  it("takes a description sitting a line above its label as description, not name (page 68)", () => {
    const out = readLayout(
      items([
        { centre: 266, y: H, s: "910-17" },
        { centre: 266, y: 664.3, s: "Spruce" },
        { centre: 266, y: D + 7.68, s: "RECLINER" },
      ]),
    );
    expect(out.get("910-17")).toEqual({ name: "Spruce", description: "RECLINER" });
  });

  describe("leaves a column out rather than guess", () => {
    const skusOf = (runs: { centre: number; y: number; s: string }[]) => [
      ...readLayout(items(runs)).keys(),
    ];

    it("when a family's names do not number its SKUs", () => {
      const twoNames = FAMILY.filter((r) => r.s !== "Cedar").map((r) =>
        r.s === "Birch /" ? { ...r, s: "Birch" } : r,
      );
      expect(skusOf(twoNames)).toEqual([]);
    });

    it("when the family's item numbers wrap onto the next line", () => {
      expect(
        skusOf([
          { centre: 200, y: H, s: "901/902/" },
          { centre: 200, y: 664.78, s: "903" },
          ...FAMILY.slice(1),
        ]),
      ).toEqual([]);
    });

    it("when a name breaks mid-word, which leaves the list a name short (page 73)", () => {
      // "Alder/Map" + "le/Cedar": the first line has no trailing "/", so the
      // list ends at "Map" -- two names for three SKUs.
      const runs = [
        { centre: 200, y: H, s: "901/902/903" },
        { centre: 200, y: 664.78, s: "-AB" },
        { centre: 200, y: 657.1, s: "Alder/Map" },
        { centre: 200, y: 649.42, s: "le/Cedar" },
        { centre: 200, y: 633.58, s: "OTTOMAN" },
      ];
      expect(skusOf(runs)).toEqual([]);
    });

    it("when a single style has two lines at name height", () => {
      const runs = [
        { centre: 266, y: H, s: "920-17" },
        { centre: 266, y: 664.3, s: "Willow" },
        { centre: 266, y: 656.62, s: "Grove" },
        { centre: 266, y: 633.58, s: "CHAIR" },
      ];
      expect(skusOf(runs)).toEqual([]);
    });

    it("when there is no description to tell a name from", () => {
      expect(
        skusOf([
          { centre: 266, y: H, s: "910-17" },
          { centre: 266, y: 664.3, s: "Spruce" },
        ]),
      ).toEqual([]);
    });

    it("when the grid has no DESCRIPTION: row", () => {
      const noDescription = items(SINGLE).filter((i) => i.s !== "DESCRIPTION:");
      expect([...readLayout(noDescription).keys()]).toEqual([]);
    });

    it("when a SKU is printed twice with different words", () => {
      const other = SINGLE.map((r) => (r.s === "Spruce" ? { ...r, s: "Poplar" } : r));
      const out = readLayout([...items(SINGLE, 1), ...items(other, 2)]);
      expect(out.has("910-17")).toBe(false);
    });
  });

  it("keeps a SKU printed twice with the same words", () => {
    const out = readLayout([...items(SINGLE, 1), ...items(SINGLE, 2)]);
    expect(out.get("910-17")?.name).toBe("Spruce");
  });

  it("ignores words centred under no column", () => {
    const out = readLayout(items([...SINGLE, { centre: 400, y: 664.3, s: "Stray" }]));
    expect(out.get("910-17")).toEqual({ name: "Spruce", description: "SWIVEL CHAIR" });
  });
});

describe("applyLayoutText", () => {
  // The rendered rows, as the tab renderer produced them for such a page: the
  // DESCRIPTION line carries the family's last name fragment.
  const rendered = [
    "<<PAGE:11>>",
    "ITEM NUMBER:\t901/902/903\t910-17",
    "-AB\tSpruce",
    "DESCRIPTION:\tCedar\tSWIVEL",
    "LEATHER - GRADE 1\t1,000\t900",
    "",
  ].join("\n");

  it("replaces the rendered description, names each style, and counts what it could not place", () => {
    const parsed = parseRenderedGrid(rendered, bradingtonYoung);
    expect(parsed.data.find((p) => p.styleNumber === "901-AB")?.description).toBe("Cedar");

    const layout = new Map([
      ["901-AB", { name: "Alder", description: "OTTOMAN" }],
      ["902-AB", { name: "Birch", description: "OTTOMAN" }],
      ["903-AB", { name: "Cedar", description: "OTTOMAN" }],
    ]);
    const out = applyLayoutText(parsed, layout);
    const by = (sku: string) => out.data.find((p) => p.styleNumber === sku)!;

    expect(by("901-AB")).toMatchObject({ styleName: "Alder", description: "OTTOMAN" });
    expect(by("903-AB")).toMatchObject({ styleName: "Cedar", description: "OTTOMAN" });
    // Not placed: neither name nor the rendered row's description survives.
    expect(by("910-17")).toMatchObject({ styleName: "", description: "" });
    expect(out.stats.layoutUnplaced).toBe(1);
    expect(
      out.diagnostics.some((d) => d.level === "warning" && /1 of 4 styles/.test(d.message)),
    ).toBe(true);
    expect(out.summary.warningCount).toBe(
      out.diagnostics.filter((d) => d.level === "warning").length,
    );
  });
});

describe("extractWholesaleGrid reads Bradington-Young names by position (real PDF)", () => {
  const run = (r: { centre: number; y: number; s: string }): Run => ({
    x: r.centre - 12,
    y: r.y,
    s: r.s,
    size: 6.24,
  });
  const pdf = () =>
    minimalPdf([
      [
        ...LABELS.map((l) => ({ ...l, size: 6.24 })),
        ...[...FAMILY, ...SINGLE].map(run),
        { x: 75, y: 560, s: "LEATHER - GRADE 1", size: 6.24 },
        { x: 190, y: 560, s: "1,000", size: 6.24 },
        { x: 256, y: 560, s: "900", size: 6.24 },
      ],
    ]);

  it("names every style and takes the real description, not the last name fragment", async () => {
    const result = await extractWholesaleGrid(pdf(), bradingtonYoung);
    const got = result.data.map((p) => [p.styleNumber, p.styleName, p.description]);
    expect(got).toEqual([
      ["901-AB", "Alder", "OTTOMAN"],
      ["902-AB", "Birch", "OTTOMAN"],
      ["903-AB", "Cedar", "OTTOMAN"],
      ["910-17", "Spruce", "SWIVEL CHAIR"],
    ]);
    expect(result.stats.layoutUnplaced).toBe(0);
  });
});
