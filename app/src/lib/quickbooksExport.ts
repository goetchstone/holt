// /app/src/lib/quickbooksExport.ts
//
// Pure builders for the QuickBooks / General Journal CSV export. No Prisma, no
// I/O -- the caller fetches journal entries and passes plain objects in, so the
// formatting is unit-testable and the same shape works for QuickBooks Desktop
// (General Journal import) and the common QBO import tools (SaasAnt, Transaction
// Pro), Xero, and any accountant's spreadsheet.
//
// Column shape matches the existing per-entry export (Journ #, Date, Memo,
// Accnt #, Debit, Credit) so an accountant's existing mapping keeps working;
// Account Name is appended as a trailing convenience column.

export interface JournalLineInput {
  accountCode: string;
  accountName: string;
  memo: string;
  debit: number;
  credit: number;
}

export interface JournalEntryInput {
  journalNumber: string;
  journalDate: Date;
  lines: JournalLineInput[];
}

// MM/DD/YYYY in UTC. Journal dates are stored at UTC midnight, so reading UTC
// parts avoids an off-by-one when the server runs in a behind-UTC timezone.
export function formatJournalDate(d: Date): string {
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  const yyyy = d.getUTCFullYear().toString();
  return `${mm}/${dd}/${yyyy}`;
}

// Blank for a zero amount -- QuickBooks expects an empty cell, not "0.00", on
// the side of the line that doesn't apply.
export function formatJournalAmount(n: number): string {
  if (!n) return "";
  return n.toFixed(2);
}

export const QUICKBOOKS_JOURNAL_HEADERS = [
  "Journal No",
  "Date",
  "Memo",
  "Account",
  "Account Name",
  "Debit",
  "Credit",
] as const;

/**
 * Flatten journal entries to row objects (one per line) ready for rowsToCsv.
 * Entries are emitted in the order given; lines preserve their order within an
 * entry. The Account column is the GL code (QuickBooks account number); Account
 * Name is the human-readable trailing column.
 */
export function journalEntriesToRows(
  entries: ReadonlyArray<JournalEntryInput>,
): Array<Record<string, string>> {
  const rows: Array<Record<string, string>> = [];
  for (const entry of entries) {
    const date = formatJournalDate(entry.journalDate);
    for (const line of entry.lines) {
      rows.push({
        "Journal No": entry.journalNumber,
        Date: date,
        Memo: line.memo,
        Account: line.accountCode,
        "Account Name": line.accountName,
        Debit: formatJournalAmount(line.debit),
        Credit: formatJournalAmount(line.credit),
      });
    }
  }
  return rows;
}

/** The per-entry export's columns, in both its formats. */
const ENTRY_FILE_HEADERS = ["Journ #", "Date", "Memo", "Accnt #", "Debit", "Credit"];

/**
 * One journal entry as the per-entry export writes it
 * (pages/api/accounting/journal-entries/[id]/export.ts): the header, then a row
 * per line. Its date is formatJournalDate's, from the UTC parts the journal's
 * day is stored in; the route read local parts until 2026-11-21, so on a server
 * west of UTC every line, and the file name, came out a day early.
 */
export function journalEntryFileRows(entry: JournalEntryInput): string[][] {
  const date = formatJournalDate(entry.journalDate);
  return [
    [...ENTRY_FILE_HEADERS],
    ...entry.lines.map((line) => [
      entry.journalNumber,
      date,
      line.memo,
      line.accountCode,
      formatJournalAmount(line.debit),
      formatJournalAmount(line.credit),
    ]),
  ];
}

/**
 * Rows as tab-delimited text with CRLF line ends: the per-entry export's default,
 * the format the accounting package imports. The format has no quoting, so a tab
 * inside a cell would split it and a CR or LF would end the row; each run of them
 * becomes one space. A memo is written raw otherwise: no formula prefix, which
 * would be imported into the books as part of the memo (accounting.md).
 */
export function tabDelimited(rows: readonly (readonly string[])[]): string {
  const cell = (text: string) => text.replace(/[\t\r\n]+/g, " ");
  return rows.map((cells) => cells.map(cell).join("\t")).join("\r\n") + "\r\n";
}
