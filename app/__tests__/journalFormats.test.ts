// /app/__tests__/journalFormats.test.ts
//
// Holt keeps the books but does not close them, so the journal has to leave in a
// shape the business's accounting package accepts. A file in the WRONG shape is
// worse than a failed export: it imports, and the books are wrong quietly.
//
// The case that matters most is Xero. It takes one SIGNED amount per line rather
// than debit/credit columns, so emitting the QuickBooks shape there would import
// every credit as a debit -- a file that looks fine and doubles the ledger.

import {
  DEFAULT_JOURNAL_FORMAT,
  getJournalFormat,
  listJournalFormats,
  type JournalEntryInput,
} from "@/lib/accounting/journalFormats";

/** One balanced entry: cash debit against revenue credit. */
const ENTRY: JournalEntryInput = {
  journalNumber: "SJ20260101",
  journalDate: new Date("2026-01-01T00:00:00.000Z"),
  lines: [
    { accountCode: "1-1006", accountName: "Cash", memo: "Daily sales", debit: 106.35, credit: 0 },
    { accountCode: "4-4080", accountName: "Sales", memo: "Daily sales", debit: 0, credit: 100 },
    { accountCode: "2-2120", accountName: "Tax", memo: "Daily sales", debit: 0, credit: 6.35 },
  ],
};

describe("every format emits one row per journal line", () => {
  it("offers the four formats, and resolves each", () => {
    const keys = listJournalFormats()
      .map((f) => f.key)
      .sort();
    expect(keys).toEqual(["quickbooks", "sage", "standard", "xero"]);
    for (const key of keys) expect(getJournalFormat(key)).not.toBeNull();
  });

  it("keeps QuickBooks as the default, so existing links still work", () => {
    expect(DEFAULT_JOURNAL_FORMAT).toBe("quickbooks");
    expect(getJournalFormat(undefined)?.key).toBe("quickbooks");
  });

  it("refuses an unknown format rather than guessing", () => {
    // A silent fall back would hand someone a QuickBooks file for Xero.
    expect(getJournalFormat("myob")).toBeNull();
  });

  it("emits a row per line, with only its own declared headers", () => {
    for (const format of listJournalFormats()) {
      const rows = format.toRows([ENTRY]);
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual([...format.headers].sort());
      }
    }
  });
});

describe("Xero takes a signed amount, not debit and credit columns", () => {
  const rows = getJournalFormat("xero")!.toRows([ENTRY]);

  it("signs debits positive and credits negative", () => {
    // The whole reason Xero needs its own format. Emitting the QuickBooks shape
    // would import every credit as a debit.
    expect(rows.map((r) => r.Amount)).toEqual(["106.35", "-100.00", "-6.35"]);
  });

  it("sums to zero, which is what a balanced journal means here", () => {
    const total = rows.reduce((s, r) => s + Number(r.Amount), 0);
    expect(Math.abs(total)).toBeLessThan(0.005);
  });

  it("sets No Tax, because tax is already its own line", () => {
    // Letting Xero re-apply tax to a journal that already carries a tax line
    // would double the tax liability.
    for (const row of rows) expect(row.TaxRate).toBe("No Tax");
  });
});

describe("the standard format is the one that imports anywhere", () => {
  const rows = getJournalFormat("standard")!.toRows([ENTRY]);

  it("writes both debit and credit explicitly, including zeros", () => {
    // An importer wanting blanks is satisfied by deleting a column; one that
    // needs a number cannot invent it.
    expect(rows[0]).toMatchObject({ Debit: "106.35", Credit: "0.00" });
    expect(rows[1]).toMatchObject({ Debit: "0.00", Credit: "100.00" });
  });

  it("uses ISO dates, which mean the same thing everywhere", () => {
    // MM/DD/YYYY does not.
    for (const row of rows) expect(row.Date).toBe("2026-01-01");
  });

  it("balances: debits equal credits", () => {
    const d = rows.reduce((s, r) => s + Number(r.Debit), 0);
    const c = rows.reduce((s, r) => s + Number(r.Credit), 0);
    expect(d).toBeCloseTo(c, 2);
  });
});

describe("Sage groups lines back into one journal", () => {
  const rows = getJournalFormat("sage")!.toRows([ENTRY]);

  it("repeats the reference on every line", () => {
    // That repetition is how Sage knows these three rows are one journal.
    expect(new Set(rows.map((r) => r.Reference))).toEqual(new Set(["SJ20260101"]));
  });

  it("marks each line debit or credit", () => {
    expect(rows.map((r) => r.Type)).toEqual(["JD", "JC", "JC"]);
  });
});
