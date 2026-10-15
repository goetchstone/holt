// /app/__tests__/americanLeatherOptions.test.ts
//
// The OPTIONS-block parsers in americanLeatherExtractor run on the server
// against `optionsText` posted to /api/pricing/import/american-leather (body
// limit 20 MB). Two of their patterns were unanchored with an unbounded
// `[^=\n]+` before a required `=`: every start position on a line with no `=`
// rescanned to the end of the line, so the scan was quadratic in line length
// (CodeQL js/polynomial-redos #2, #3). The name run is now capped, which keeps
// it linear. These tests pin the parse of an ordinary block, then run the
// adversarial input CodeQL describes against a generous time budget.

import { extractCushionOptions, parseOptionPrices } from "@/lib/pricing/americanLeatherExtractor";

const OPTIONS_BLOCK = [
  "OPTIONS",
  "Cushion options are calculated per seat",
  "*Dwn = $150   *Tufted = $100",
  "*Trillium=$150",
  "*Gel =",
  "$75",
  "Nailhead Trim = $250",
  "Headrest Pillow = $ 1,200 / seat",
  "Power = $300",
  "Battery=$150",
  "MATTRESS OPTIONS",
  "KING $380 $1000",
].join("\n");

// Generous on purpose: the linear scan takes a few ms here; the quadratic one
// it replaced took ~600 ms per pattern on 50k characters.
const BUDGET_MS = 200;

function elapsedMs(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

describe("extractCushionOptions", () => {
  it("reads asterisk-marked options in text order, names trimmed", () => {
    expect(extractCushionOptions(OPTIONS_BLOCK)).toEqual([
      { name: "Dwn", price: 150 },
      { name: "Tufted", price: 100 },
      { name: "Trillium", price: 150 },
      // `\s` after the `=` may cross the line break PDF extraction inserts.
      { name: "Gel", price: 75 },
    ]);
  });

  it("stays linear on a long line of asterisks with no `=`", () => {
    const adversarial = "*" + "*<".repeat(25_000); // 50,001 chars
    let result: unknown;
    const ms = elapsedMs(() => {
      result = extractCushionOptions(adversarial);
    });
    expect(result).toEqual([]);
    expect(ms).toBeLessThan(BUDGET_MS);
  });
});

describe("parseOptionPrices", () => {
  it("parses an ordinary OPTIONS block unchanged", () => {
    expect(parseOptionPrices(OPTIONS_BLOCK)).toEqual([
      { optionName: "Dwn", retailPrice: 150, wholesalePrice: null, perSeat: true },
      { optionName: "Tufted", retailPrice: 100, wholesalePrice: null, perSeat: true },
      { optionName: "Trillium", retailPrice: 150, wholesalePrice: null, perSeat: true },
      { optionName: "Gel", retailPrice: 75, wholesalePrice: null, perSeat: true },
      { optionName: "Nailhead Trim", retailPrice: 250, wholesalePrice: null, perSeat: false },
      { optionName: "Headrest Pillow", retailPrice: 1200, wholesalePrice: null, perSeat: true },
    ]);
  });

  it.each([
    ["asterisks with no `=`", "*" + "*<".repeat(25_000)],
    ["words with no `=`", "a ".repeat(25_000)],
  ])("stays linear on a long line of %s", (_label, adversarial) => {
    let result: unknown;
    const ms = elapsedMs(() => {
      result = parseOptionPrices(adversarial);
    });
    expect(result).toEqual([]);
    expect(ms).toBeLessThan(BUDGET_MS);
  });
});
