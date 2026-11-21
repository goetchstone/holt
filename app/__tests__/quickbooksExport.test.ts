// /app/__tests__/quickbooksExport.test.ts

import {
  formatJournalDate,
  formatJournalAmount,
  journalEntriesToRows,
  journalEntryFileRows,
  journalFileDate,
  QUICKBOOKS_JOURNAL_HEADERS,
  tabDelimited,
  type JournalEntryFileInput,
  type JournalEntryInput,
} from "@/lib/quickbooksExport";
import { rowsToCsv } from "@/lib/csv";

/** The store's zone, AppSettings.timezone's default. */
const STORE_ZONE = "America/New_York";

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

  // A sales journal: generateSalesJournal (journalEntry.ts) stores its day as a
  // marker, UTC midnight of the business day.
  const entry = (memo: string): JournalEntryFileInput => ({
    journalNumber: "SJ20260501",
    journalType: "SALES",
    journalDate: new Date("2026-05-01T00:00:00.000Z"),
    lines: [
      { accountCode: "1-1006", accountName: "Cash", memo, debit: 1000, credit: 0 },
      { accountCode: "4-4001", accountName: "Sales", memo: "Dept A", debit: 0, credit: 1000 },
    ],
  });

  test("dates each line by the journal's day on a server west of UTC", () => {
    onServerWestOfUtc();
    expect(new Date("2026-05-01T00:00:00.000Z").getDate()).toBe(30); // the simulation holds
    expect(journalEntryFileRows(entry("Amex"), STORE_ZONE)).toEqual([
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
    const text = tabDelimited(journalEntryFileRows(entry(memo), STORE_ZONE));
    // An importer may end a row at any of CR, LF or CRLF.
    const lines = text.split(/\r\n|\r|\n/);
    expect(lines).toHaveLength(4); // the header, two lines, and the empty tail after the last CRLF
    expect(lines[3]).toBe("");
    for (const line of lines.slice(0, 3)) expect(line.split("\t")).toHaveLength(6);
    expect(lines[1].split("\t")[2]).toBe(written);
  });

  test("writes any other memo as it is: no quoting and no formula prefix", () => {
    const text = tabDelimited(journalEntryFileRows(entry('-Refund "A", =1'), STORE_ZONE));
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

// Two writers, two kinds of date in one DateTime column. generateSalesJournal
// (journalEntry.ts) stores a sales journal's day as a marker, UTC midnight of
// the business day; postJournal (billing/invoiceService.ts) stores an AR
// journal's (ARI-, ARV-, ARP-) as the instant it posted. Each is dated by the
// store's business day: a marker by its own date, an instant by the day it
// fell on in the store's zone (businessDayKey).
describe("the per-entry export dates each journal by the store's business day", () => {
  afterEach(() => jest.restoreAllMocks());

  const journal = (
    journalType: JournalEntryFileInput["journalType"],
    journalDate: string,
  ): JournalEntryFileInput => ({
    journalNumber: journalType === "SALES" ? "SJ20260501" : "ARI-INV-1001",
    journalType,
    journalDate: new Date(journalDate),
    lines: [{ accountCode: "1-1200", accountName: "AR", memo: "Invoice", debit: 80, credit: 0 }],
  });
  const dateOf = (entry: JournalEntryFileInput, zone: string) =>
    journalEntryFileRows(entry, zone)[1][1];

  test.each([
    // 9:30 PM on May 1 in New York is 01:30 on May 2 in UTC.
    ["AR_SALE", "2026-05-02T01:30:00.000Z", STORE_ZONE, "05/01/2026"],
    // 1:30 AM on May 2 in Tokyo is 16:30 on May 1 in UTC.
    ["AR_PAYMENT", "2026-05-01T16:30:00.000Z", "Asia/Tokyo", "05/02/2026"],
    ["AR_PAYMENT", "2026-05-01T15:00:00.000Z", STORE_ZONE, "05/01/2026"],
    // Nothing writes a purchasing journal; a DateTime holds an instant.
    ["PURCHASING", "2026-05-02T01:30:00.000Z", STORE_ZONE, "05/01/2026"],
  ] as const)(
    "an instant: %s posted at %s is dated by the day in %s",
    (type, posted, zone, date) => {
      expect(dateOf(journal(type, posted), zone)).toBe(date);
    },
  );

  test.each([STORE_ZONE, "Asia/Tokyo", "America/Los_Angeles", "UTC"])(
    "a day marker: a sales journal for May 1 is dated May 1 in %s",
    (zone) => {
      expect(dateOf(journal("SALES", "2026-05-01T00:00:00.000Z"), zone)).toBe("05/01/2026");
    },
  );

  test("the server's own zone plays no part, for either kind", () => {
    onServerWestOfUtc();
    expect(dateOf(journal("AR_SALE", "2026-05-02T01:30:00.000Z"), STORE_ZONE)).toBe("05/01/2026");
    expect(dateOf(journal("SALES", "2026-05-01T00:00:00.000Z"), STORE_ZONE)).toBe("05/01/2026");
  });

  test("names the file by the same day", () => {
    const evening = journal("AR_SALE", "2026-05-02T01:30:00.000Z");
    expect(journalFileDate(evening, STORE_ZONE)).toBe("05/01/2026");
  });
});
