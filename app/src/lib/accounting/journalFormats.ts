// /app/src/lib/accounting/journalFormats.ts
//
// General Journal export formats.
//
// Holt keeps the books but is not where they are closed: there is no P&L,
// balance sheet or AP here, and JournalEntry carries an EXPORTED status for the
// handoff. That handoff only works if the file lands in whatever the business
// actually uses, so format is a registry rather than one hardcoded shape -- the
// same seam as source adapters and import runners.
//
// STANDARD is the one to reach for when in doubt. It is a plain double-entry
// journal -- date, reference, account code, account name, description, debit,
// credit -- which is the shape every accounting package on earth understands,
// because it is just what a journal IS. Nothing collapsed, renamed or inferred.
// An accountant can map those seven columns into anything in five minutes, and
// nothing silently changes meaning on the way in.
//
// VERIFY A VENDOR FORMAT BEFORE TRUSTING IT. The named formats follow each
// product's published manual-journal import shape, but those templates change
// between versions and regions. Import one period into a sandbox company and
// reconcile the totals first. STANDARD is not subject to that caveat, which is
// most of the reason it exists.

import type { JournalEntryInput, JournalLineInput } from "@/lib/quickbooksExport";
import {
  QUICKBOOKS_JOURNAL_HEADERS,
  formatJournalAmount,
  formatJournalDate,
  journalEntriesToRows,
} from "@/lib/quickbooksExport";

export type JournalRow = Record<string, string>;

export interface JournalFormat {
  key: string;
  label: string;
  /** What an operator needs to know before trusting the file. */
  note: string;
  headers: readonly string[];
  toRows(entries: ReadonlyArray<JournalEntryInput>): JournalRow[];
}

/** ISO date. Journal dates are stored at UTC midnight, so read UTC parts. */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * A plain double-entry journal. Works with anything that imports journals.
 *
 * Debit and credit are separate columns and both are always written, including
 * "0.00" -- an importer that wants blanks is trivially satisfied by deleting a
 * column, whereas one that needs a number cannot invent it. ISO dates for the
 * same reason: unambiguous everywhere, where MM/DD/YYYY is not.
 */
const STANDARD: JournalFormat = {
  key: "standard",
  label: "Standard double-entry journal (works anywhere)",
  note: "Plain journal columns with ISO dates and explicit debit/credit. Import this when your package is not listed, or when a vendor template has changed.",
  headers: ["Date", "Reference", "AccountCode", "AccountName", "Description", "Debit", "Credit"],
  toRows(entries) {
    const rows: JournalRow[] = [];
    for (const entry of entries) {
      for (const line of entry.lines) {
        rows.push({
          Date: isoDate(entry.journalDate),
          Reference: entry.journalNumber,
          AccountCode: line.accountCode,
          AccountName: line.accountName,
          Description: line.memo || line.accountName,
          Debit: (line.debit || 0).toFixed(2),
          Credit: (line.credit || 0).toFixed(2),
        });
      }
    }
    return rows;
  },
};

/**
 * Xero manual journals.
 *
 * Xero takes ONE SIGNED amount per line rather than debit/credit columns:
 * positive debits, negative credits. Emitting both columns the way QuickBooks
 * does would import every credit as a debit, so the split is collapsed here.
 *
 * TaxRate is the no-tax code on purpose. These entries already carry tax as its
 * own line against the tax liability account; letting Xero apply tax again
 * would double it.
 */
const XERO: JournalFormat = {
  key: "xero",
  label: "Xero (manual journals)",
  note: "Amount is signed: positive debit, negative credit. TaxRate is No Tax because tax is already its own journal line — re-applying it would double the tax.",
  headers: ["Narration", "Date", "Description", "AccountCode", "TaxRate", "Amount"],
  toRows(entries) {
    const rows: JournalRow[] = [];
    for (const entry of entries) {
      for (const line of entry.lines) {
        const signed = line.debit ? line.debit : -line.credit;
        rows.push({
          Narration: entry.journalNumber,
          Date: isoDate(entry.journalDate),
          Description: line.memo || line.accountName,
          AccountCode: line.accountCode,
          TaxRate: "No Tax",
          Amount: signed.toFixed(2),
        });
      }
    }
    return rows;
  },
};

/**
 * Sage nominal-ledger journals.
 *
 * Debit and credit stay separate, but the nominal code gets its own column and
 * the reference repeats on every line -- that repetition is how Sage groups
 * lines back into one journal.
 */
const SAGE: JournalFormat = {
  key: "sage",
  label: "Sage (nominal ledger journal)",
  note: "Nominal code in its own column, reference repeated on every line — that repetition is how Sage groups lines back into one journal.",
  headers: ["Type", "Nominal", "Date", "Reference", "Details", "Debit", "Credit"],
  toRows(entries) {
    const rows: JournalRow[] = [];
    for (const entry of entries) {
      for (const line of entry.lines) {
        rows.push({
          Type: line.debit ? "JD" : "JC",
          Nominal: line.accountCode,
          Date: formatJournalDate(entry.journalDate),
          Reference: entry.journalNumber,
          Details: line.memo || line.accountName,
          Debit: formatJournalAmount(line.debit),
          Credit: formatJournalAmount(line.credit),
        });
      }
    }
    return rows;
  },
};

const QUICKBOOKS: JournalFormat = {
  key: "quickbooks",
  label: "QuickBooks (general journal)",
  note: "The proven shape this export shipped with. Blank rather than 0.00 on the side of a line that does not apply, which is what QuickBooks expects.",
  headers: QUICKBOOKS_JOURNAL_HEADERS,
  toRows: (entries) => journalEntriesToRows(entries) as JournalRow[],
};

const FORMATS: Record<string, JournalFormat> = {
  [QUICKBOOKS.key]: QUICKBOOKS,
  [XERO.key]: XERO,
  [SAGE.key]: SAGE,
  [STANDARD.key]: STANDARD,
};

/** Unchanged default: existing links and bookmarks expect QuickBooks. */
export const DEFAULT_JOURNAL_FORMAT = QUICKBOOKS.key;

export function getJournalFormat(key: string | undefined): JournalFormat | null {
  if (!key) return FORMATS[DEFAULT_JOURNAL_FORMAT];
  return FORMATS[key.toLowerCase()] ?? null;
}

export function listJournalFormats(): JournalFormat[] {
  return Object.values(FORMATS);
}

export type { JournalEntryInput, JournalLineInput };
