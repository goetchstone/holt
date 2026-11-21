// /app/__tests__/csvFormulaInjection.test.ts
//
// CSV injection: a cell starting with = + - @ tab or CR is run as a formula by
// Excel/Sheets/Numbers. Both CSV helpers must neutralise (prefix a single
// quote) string cells, leave plain numbers and number values alone, and leave
// every other value byte-identical. See csvExportManifest.test.ts for the
// coverage of producers.

import Papa from "papaparse";
import { neutraliseFormulaCell, neutraliseRow, rowsToCsv } from "../src/lib/csv";
import { csvCell, csvRow } from "../src/lib/csvExport";
import { journalEntryFileRows } from "../src/lib/quickbooksExport";

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

describe("crlfCsv (journal-entry export)", () => {
  // The journal export used to build rows with csvRow and then replace every
  // "\n" with "\r\n", which also rewrote newlines inside a quoted memo: an
  // embedded LF became CRLF and an embedded CRLF became CR CR LF.
  it("keeps a newline inside a quoted cell as it is", () => {
    const { crlfCsv } = jest.requireActual("@/lib/csvExport");
    const csv = crlfCsv([
      ["Memo", "Debit"],
      ["line one\nline two", "10.00"],
      ["a\r\nb", "-5.00"],
    ]);
    expect(csv).toBe('Memo,Debit\r\n"line one\nline two",10.00\r\n"a\r\nb",-5.00\r\n');
  });

  it("neutralises a formula cell and leaves a plain negative amount alone", () => {
    const { crlfCsv } = jest.requireActual("@/lib/csvExport");
    expect(crlfCsv([["=SUM(A1:A2)", "-12.50", -3]])).toBe("'=SUM(A1:A2),-12.50,-3\r\n");
  });

  // Bytes alone don't say a file imports. This reads the export back with a real
  // CSV parser: every cell returns as written, except that text starting with a
  // trigger gains exactly one leading ' (never an amount, number, code or date).
  it("reads back cell for cell, as the journal-entry export writes it", () => {
    const { crlfCsv } = jest.requireActual("@/lib/csvExport");
    const memos = [
      'Say "hi"',
      "Cash, card",
      "two\r\nlines",
      "one\nline",
      "-Refund",
      "=SUM(A1:A2)",
      "-12.50",
    ];
    const rows: string[][] = journalEntryFileRows({
      journalNumber: "SJ20260501",
      journalDate: new Date("2026-05-01T00:00:00.000Z"),
      lines: memos.map((memo) => ({
        accountCode: "1-1006",
        accountName: "Cash",
        memo,
        debit: 1000,
        credit: 0,
      })),
    });
    const back = Papa.parse<string[]>(crlfCsv(rows), { newline: "\r\n", skipEmptyLines: true });

    expect(back.errors).toEqual([]);
    expect(back.data.map((cells) => cells[2])).toEqual([
      "Memo",
      'Say "hi"',
      "Cash, card",
      "two\r\nlines",
      "one\nline",
      "'-Refund",
      "'=SUM(A1:A2)",
      "-12.50",
    ]);
    const notMemo = (cells: string[]) => [cells[0], cells[1], cells[3], cells[4], cells[5]];
    expect(back.data.map(notMemo)).toEqual(rows.map(notMemo));
    expect(back.data[1]).toEqual(["SJ20260501", rows[1][1], 'Say "hi"', "1-1006", "1000.00", ""]);
  });
});
