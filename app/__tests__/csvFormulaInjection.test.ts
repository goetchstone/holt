// /app/__tests__/csvFormulaInjection.test.ts
//
// CSV injection: a cell starting with = + - @ tab or CR is run as a formula by
// Excel/Sheets/Numbers. Both CSV helpers must neutralise (prefix a single
// quote) string cells, leave plain numbers and number values alone, and leave
// every other value byte-identical. See csvExportManifest.test.ts for the
// coverage of producers.

import { neutraliseFormulaCell, neutraliseRow, rowsToCsv } from "../src/lib/csv";
import { csvCell, csvRow } from "../src/lib/csvExport";

const PAYLOADS = [
  '=HYPERLINK("http://x","y")',
  "+cmd|' /C calc'!A0",
  "-2+3",
  "@SUM(A1:A2)",
  "\t=1+1",
  "\r=1+1",
];

describe("neutraliseFormulaCell", () => {
  it.each(PAYLOADS)("prefixes a quote to %j", (p) => {
    expect(neutraliseFormulaCell(p)).toBe(`'${p}`);
  });

  it.each(["-12.50", "+3", "-7", "0.5", "-.5", ""])("leaves %j alone", (v) => {
    expect(neutraliseFormulaCell(v)).toBe(v);
  });

  it("leaves ordinary text alone", () => {
    expect(neutraliseFormulaCell("Smith, John")).toBe("Smith, John");
    expect(neutraliseFormulaCell("a=b")).toBe("a=b");
  });

  it("neutraliseRow touches strings only", () => {
    expect(neutraliseRow({ a: "=1", b: -5, c: null, d: "-3.00" })).toEqual({
      a: "'=1",
      b: -5,
      c: null,
      d: "-3.00",
    });
  });
});

describe("csvCell / csvRow", () => {
  it("neutralises, then still quotes what needs quoting", () => {
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(csvCell("+cmd|' /C calc'!A0")).toBe("'+cmd|' /C calc'!A0");
    expect(csvCell("-2+3")).toBe("'-2+3");
    expect(csvCell("@SUM(A1:A2)")).toBe("'@SUM(A1:A2)");
    expect(csvCell("\t=1")).toBe("'\t=1");
    expect(csvCell("\r=1")).toBe(`"'\r=1"`);
  });

  it("exempts plain-number strings, number values, empty and null", () => {
    expect(csvCell("-12.50")).toBe("-12.50");
    expect(csvCell("+3")).toBe("+3");
    expect(csvCell(12.5)).toBe("12.5");
    expect(csvCell(-1e-7)).toBe("-1e-7");
    expect(csvCell("")).toBe("");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("is byte-identical for values that do not start with a trigger", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvRow(["a", 1, null, "-4.00", "=x"])).toBe("a,1,,-4.00,'=x\n");
  });
});

describe("rowsToCsv", () => {
  it("neutralises string cells and headers, leaves numbers", () => {
    const csv = rowsToCsv([{ Memo: "=1+1", Debit: -12.5, Credit: "-12.50", "@h": "x" }]);
    expect(csv).toBe("Memo,Debit,Credit,'@h\r\n'=1+1,-12.5,-12.50,x");
  });

  it("is byte-identical for ordinary rows", () => {
    expect(rowsToCsv([{ a: "x,y", b: 2, c: null, d: new Date("2026-01-02T00:00:00Z") }])).toBe(
      'a,b,c,d\r\n"x,y",2,,2026-01-02T00:00:00.000Z',
    );
  });
});
