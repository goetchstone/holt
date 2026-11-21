// /app/__tests__/quickbooksExport.test.ts

import {
  formatJournalDate,
  formatJournalAmount,
  journalEntriesToRows,
  journalEntryFileRows,
  QUICKBOOKS_JOURNAL_HEADERS,
  tabDelimited,
  type JournalEntryInput,
} from "@/lib/quickbooksExport";
import { rowsToCsv } from "@/lib/csv";

describe("formatJournalDate", () => {
  test("formats UTC midnight as MM/DD/YYYY without timezone drift", () => {
    expect(formatJournalDate(new Date("2026-05-30T00:00:00.000Z"))).toBe("05/30/2026");
    expect(formatJournalDate(new Date("2026-01-05T00:00:00.000Z"))).toBe("01/05/2026");
  });
});

describe("formatJournalAmount", () => {
  test("zero becomes an empty cell", () => {
    expect(formatJournalAmount(0)).toBe("");
  });
  test("non-zero gets two decimals", () => {
    expect(formatJournalAmount(1234.5)).toBe("1234.50");
    expect(formatJournalAmount(10)).toBe("10.00");
  });
});

describe("journalEntriesToRows", () => {
  const entries: JournalEntryInput[] = [
    {
      journalNumber: "JE-1001",
      journalDate: new Date("2026-05-30T00:00:00.000Z"),
      lines: [
        { accountCode: "1000", accountName: "Cash", memo: "Daily sales", debit: 500, credit: 0 },
        {
          accountCode: "4010",
          accountName: "Sales Revenue",
          memo: "Daily sales",
          debit: 0,
          credit: 500,
        },
      ],
    },
  ];

  test("emits one row per line with the right columns and blank opposite side", () => {
    const rows = journalEntriesToRows(entries);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      "Journal No": "JE-1001",
      Date: "05/30/2026",
      Memo: "Daily sales",
      Account: "1000",
      "Account Name": "Cash",
      Debit: "500.00",
      Credit: "",
    });
    expect(rows[1].Credit).toBe("500.00");
    expect(rows[1].Debit).toBe("");
  });

  test("round-trips through rowsToCsv with the documented header order", () => {
    const csv = rowsToCsv(journalEntriesToRows(entries));
    const header = csv.split("\r\n")[0];
    expect(header).toBe(QUICKBOOKS_JOURNAL_HEADERS.join(","));
  });

  test("empty input yields no rows", () => {
    expect(journalEntriesToRows([])).toEqual([]);
  });
});

/**
 * Date's local getters as a server eight hours west of UTC reads them, whatever
 * this machine's zone: Jest can't change the process's zone, and CI runs in UTC,
 * where local and UTC getters agree and a test of the date couldn't fail.
 */
function onServerWestOfUtc(): void {
  const west = (d: Date) => new Date(d.getTime() - 8 * 3_600_000);
  jest.spyOn(Date.prototype, "getFullYear").mockImplementation(function (this: Date) {
    return west(this).getUTCFullYear();
  });
  jest.spyOn(Date.prototype, "getMonth").mockImplementation(function (this: Date) {
    return west(this).getUTCMonth();
  });
  jest.spyOn(Date.prototype, "getDate").mockImplementation(function (this: Date) {
    return west(this).getUTCDate();
  });
}

describe("the per-entry export (journal-entries/[id]/export.ts)", () => {
  afterEach(() => jest.restoreAllMocks());

  // Stored at UTC midnight, as journalEntry.ts writes a journal's day.
  const entry = (memo: string): JournalEntryInput => ({
    journalNumber: "SJ20260501",
    journalDate: new Date("2026-05-01T00:00:00.000Z"),
    lines: [
      { accountCode: "1-1006", accountName: "Cash", memo, debit: 1000, credit: 0 },
      { accountCode: "4-4001", accountName: "Sales", memo: "Dept A", debit: 0, credit: 1000 },
    ],
  });

  test("dates each line by the journal's day on a server west of UTC", () => {
    onServerWestOfUtc();
    expect(new Date("2026-05-01T00:00:00.000Z").getDate()).toBe(30); // the simulation holds
    expect(journalEntryFileRows(entry("Amex"))).toEqual([
      ["Journ #", "Date", "Memo", "Accnt #", "Debit", "Credit"],
      ["SJ20260501", "05/01/2026", "Amex", "1-1006", "1000.00", ""],
      ["SJ20260501", "05/01/2026", "Dept A", "4-4001", "", "1000.00"],
    ]);
  });

  test.each([
    ["a tab", "Gift\tcard", "Gift card"],
    ["CRLF", "Deposit\r\nrefund", "Deposit refund"],
    ["LF", "Deposit\nrefund", "Deposit refund"],
    ["CR", "Deposit\rrefund", "Deposit refund"],
    ["a run of them", "a\t\r\n\tb", "a b"],
  ])("a memo holding %s can't break its tab-delimited row", (_what, memo, written) => {
    const text = tabDelimited(journalEntryFileRows(entry(memo)));
    // An importer may end a row at any of CR, LF or CRLF.
    const lines = text.split(/\r\n|\r|\n/);
    expect(lines).toHaveLength(4); // the header, two lines, and the empty tail after the last CRLF
    expect(lines[3]).toBe("");
    for (const line of lines.slice(0, 3)) expect(line.split("\t")).toHaveLength(6);
    expect(lines[1].split("\t")[2]).toBe(written);
  });

  test("writes any other memo as it is: no quoting and no formula prefix", () => {
    const text = tabDelimited(journalEntryFileRows(entry('-Refund "A", =1')));
    expect(text.split("\r\n")[1].split("\t")).toEqual([
      "SJ20260501",
      expect.any(String),
      '-Refund "A", =1',
      "1-1006",
      "1000.00",
      "",
    ]);
  });
});
