// /app/__tests__/quickbooksExport.test.ts

import {
  formatJournalDate,
  formatJournalAmount,
  journalEntriesToRows,
  QUICKBOOKS_JOURNAL_HEADERS,
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
