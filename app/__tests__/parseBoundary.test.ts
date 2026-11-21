// The shared parse boundary of the lib/pricing parsers: a cut or unreadable line
// is reported on the order, never silent, and no number read is ever Infinity.
import {
  MAX_LINE_LENGTH,
  splitLines,
  parseMoney,
  finiteFloat,
  finiteInt,
  finiteOrNull,
  finiteSum,
} from "@/lib/pricing/parseBoundary";
import { parseSuperCatOrderText } from "@/lib/pricing/superCatOrderParser";
import { parseKKOrderText } from "@/lib/pricing/kkOrderParser";
import { parseNuOrderText } from "@/lib/pricing/nuorderParser";
import { parseZSupplyText } from "@/lib/pricing/zSupplyParser";
import { parseHDProposalText } from "@/lib/pricing/hdProposalParser";

describe("splitLines", () => {
  it("returns normal lines untouched and warns of nothing", () => {
    const warnings: string[] = [];
    expect(splitLines("a\nb 12.00\n\nc", warnings)).toEqual(["a", "b 12.00", "", "c"]);
    expect(warnings).toEqual([]);
  });

  it("cuts an over-long line and says how many, and the limit", () => {
    const warnings: string[] = [];
    const lines = splitLines(
      `${"x".repeat(MAX_LINE_LENGTH + 5)}\nok\n${"y".repeat(5000)}`,
      warnings,
    );
    expect(lines.map((l) => l.length)).toEqual([MAX_LINE_LENGTH, 2, MAX_LINE_LENGTH]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^2 lines are longer than 1000 characters/);
  });

  it("warns of a number with 300 or more digits, and not of a 299-digit one", () => {
    const warnings: string[] = [];
    splitLines(`1$${"9".repeat(299)}.00`, warnings);
    expect(warnings).toEqual([]);
    splitLines(`1$${"9".repeat(300)}.00`, warnings);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^1 line has a number of 300 or more digits/);
  });

  it("says the long number may have been read as 0 or left out, true of every caller", () => {
    // Past 308 digits a number is read as 0 (an order) or left out (a price book);
    // a 300-308 digit one still reads, so the warning cannot say it was read as 0.
    const warnings: string[] = [];
    splitLines("9".repeat(400), warnings);
    expect(warnings[0]).toContain(
      "cannot be a real amount, so it may have been read as 0 or left out",
    );
  });
});

describe("number readers", () => {
  it("read an overflowing run as 0 and real numbers as themselves", () => {
    expect(parseMoney("9".repeat(400))).toBe(0);
    expect(parseMoney("1,234.50")).toBe(1234.5);
    expect(finiteInt("9".repeat(400))).toBe(0);
    expect(finiteInt("42")).toBe(42);
  });

  it.each([
    ["a 400-digit run", "9".repeat(400)],
    ["1e999", "1e999"],
    ["Infinity", "Infinity"],
    ["-Infinity", "-Infinity"],
    ["abc", "abc"],
    ["a blank", ""],
  ])("finiteOrNull reads %s as null, where 'not stated' is never 0", (_label, raw) => {
    expect(finiteOrNull(raw)).toBeNull();
  });

  it("finiteOrNull reads a real number as itself, and finiteFloat reads null as 0", () => {
    expect(finiteOrNull("12.50")).toBe(12.5);
    expect(finiteFloat("12.50")).toBe(12.5);
    expect(finiteFloat("1e999")).toBe(0);
  });

  it("finiteSum adds finite amounts, and reads a sum that overflows as 0", () => {
    const biggest = Number("9".repeat(308)); // still finite on its own
    expect(Number.isFinite(biggest)).toBe(true);
    expect(finiteSum([15, 20.5])).toBe(35.5);
    expect(finiteSum([])).toBe(0);
    expect(finiteSum([biggest, biggest])).toBe(0);
  });
});

describe("parsers surface the warning on their order", () => {
  it("SuperCat: long line warns, ordinary text does not", () => {
    expect(parseSuperCatOrderText("Ref #: A1\nGrand Total$1.00").warnings).toEqual([]);
    const long = parseSuperCatOrderText(`Ref #: A1\n${"z".repeat(MAX_LINE_LENGTH + 1)}`);
    expect(long.warnings.some((w) => /longer than 1000 characters/.test(w))).toBe(true);
  });

  it("K&K: long line warns", () => {
    const r = parseKKOrderText(`Order Number: 1\n${"z".repeat(MAX_LINE_LENGTH + 1)}`);
    expect(r.warnings.some((w) => /longer than 1000 characters/.test(w))).toBe(true);
  });

  it.each([
    ["nuORDER", parseNuOrderText],
    ["Z Supply", parseZSupplyText],
    ["Hunter Douglas", parseHDProposalText],
  ])("%s: a long line warns, ordinary text does not", (_name, parse) => {
    expect(parse("Order #: 1\nTerms: Net 30").warnings).toEqual([]);
    const long = parse(`Order #: 1\n${"z".repeat(MAX_LINE_LENGTH + 1)}`);
    expect(long.warnings.some((w) => /longer than 1000 characters/.test(w))).toBe(true);
  });

  const big = `${"9".repeat(400)}.00`;

  it("nuORDER: a 400-digit price and total read as 0, never Infinity, and are reported", () => {
    const po = parseNuOrderText(
      ["Style #: ET100BLK", `$${big} 3 $${big}`, `Total Price: $${big}`].join("\n"),
    );
    expect(po.items).toMatchObject([{ styleNumber: "ET100BLK", unitPrice: 0, totalPrice: 0 }]);
    expect(po.totalPrice).toBe(0);
    expect(po.warnings.some((w) => /300 or more digits/.test(w))).toBe(true);
  });

  it("Hunter Douglas: a 400-digit amount reads as 0, never Infinity, and is reported", () => {
    const proposal = parseHDProposalText(
      [
        "Hunter Douglas Duette Honeycomb Shades",
        `1${big}${big}${big}`,
        `Freight Charges : ${big}`,
        `Installation Charges : ${big}`,
      ].join("\n"),
    );
    expect(proposal.items).toMatchObject([
      { msrp: 0, each: 0, extended: 0, freight: 0, install: 0 },
    ]);
    expect([proposal.totalFreight, proposal.totalInstall]).toEqual([0, 0]);
    expect(proposal.warnings.some((w) => /300 or more digits/.test(w))).toBe(true);
  });

  it("Hunter Douglas: freight charges that each read, but overflow when added, total 0", () => {
    const huge = `${"9".repeat(308)}.00`;
    const proposal = parseHDProposalText(
      [`Freight Charges : ${huge}`, `Freight Charges : ${huge}`].join("\n"),
    );
    expect(proposal.totalFreight).toBe(0);
  });

  it("Z Supply: a pack count that overflows once multiplied leaves the item out, named", () => {
    // 308 digits still read as a number; a pack of 2 of a size doubles it past 1.8e308.
    const invoice = parseZSupplyText(
      [
        "ZT100001BLKEasy Rib Tank Black",
        "A    B    C    D    E    F   XS    S    M    L   XL",
        `${"9".repeat(308)}  48.00     48.00`,
      ].join("\n"),
    );
    expect(invoice.items).toEqual([]);
    expect(invoice.warnings.some((w) => w.startsWith("Style ZT100001"))).toBe(true);
    expect([invoice.totalUnits, invoice.totalPrice].every(Number.isFinite)).toBe(true);
  });
});
