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

import type { JournalType } from "@prisma/client";
import { businessDayKey } from "@/lib/reports/businessDay";

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

/**
 * What each journal type keeps in JournalEntry.journalDate, a DateTime, by its
 * writer (accounting.md, "Export to QuickBooks Desktop"):
 *   SALES       a day marker, UTC midnight of the business day it covers
 *               (generateSalesJournal, lib/journalEntry.ts)
 *   AR_SALE,    the instant it posted: ARI-, ARV- and ARP- journals
 *   AR_PAYMENT  (postJournal, lib/billing/invoiceService.ts)
 *   PURCHASING  nothing writes one; a DateTime holds an instant unless its
 *               writer says otherwise
 * A new type fails to compile here until it is given one.
 */
const JOURNAL_DATE_HOLDS: Record<JournalType, "day marker" | "instant"> = {
  SALES: "day marker",
  AR_SALE: "instant",
  AR_PAYMENT: "instant",
  PURCHASING: "instant",
};

/**
 * A journal's business day as YYYY-MM-DD: a day marker's own date, read from
 * its UTC parts, and an instant's day on the store's clock (`timeZone`,
 * AppSettings.timezone) through businessDayKey, as the reports bucket a sale.
 * Neither reads the server's zone.
 */
export function journalDayKey(
  entry: { journalType: JournalType; journalDate: Date },
  timeZone: string,
): string {
  return JOURNAL_DATE_HOLDS[entry.journalType] === "day marker"
    ? entry.journalDate.toISOString().slice(0, 10)
    : businessDayKey(entry.journalDate, timeZone);
}

// MM/DD/YYYY from the UTC parts: a day marker's own date. A sales journal's
// date is one, so this avoids an off-by-one when the server runs in a
// behind-UTC timezone. An AR journal's date is an instant, which this reads as
// its UTC day; journalDayKey dates either kind by the store's day.
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

/** A journal entry as the per-entry export reads it: with its type, which says what its date holds. */
export interface JournalEntryFileInput extends JournalEntryInput {
  journalType: JournalType;
}

/**
 * The per-entry export's date for a journal, MM/DD/YYYY: its business day in
 * the store's zone (journalDayKey), on every line and in the file name.
 */
export function journalFileDate(entry: JournalEntryFileInput, timeZone: string): string {
  const [yyyy, mm, dd] = journalDayKey(entry, timeZone).split("-");
  return `${mm}/${dd}/${yyyy}`;
}

/**
 * One journal entry as the per-entry export writes it
 * (pages/api/accounting/journal-entries/[id]/export.ts): the header, then a row
 * per line, each dated by journalFileDate. Until 2026-11-21 the route read the
 * date's local parts, so on a server west of UTC a sales journal's lines and
 * file name came out a day early, and an AR journal was dated by the server's
 * day rather than the store's.
 */
export function journalEntryFileRows(entry: JournalEntryFileInput, timeZone: string): string[][] {
  const date = journalFileDate(entry, timeZone);
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
