"use client";

// /app/src/app/(dashboard)/app/admin/accounting/journal-entries/JournalEntriesView.tsx
//
// Sales Journal Entries body. App Router port of the legacy
// admin/accounting/journal-entries page (minus MainLayout chrome, supplied by
// the (dashboard) layout). Generate / post / export / delete / reconcile daily
// sales journal entries via the shared /api/accounting/journal-entries REST
// endpoints. Currency renders via useMoneyFormatter (org-configured currency,
// cents kept); journal dates render MM/DD/YYYY to match the reconcile guard.

import { useCallback, useEffect, useState } from "react";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { getErrorMessage } from "@/lib/toastError";
import {
  RECONCILIATION_CATEGORIES,
  type ReconciliationCategory,
  reconciliationHeader,
  reconciliationPanelClass,
  driftCellClass,
} from "@/lib/dailyReconciliationDisplay";

interface JournalEntryListItem {
  id: number;
  journalNumber: string;
  journalDate: string;
  journalType: string;
  status: string;
  storeLocation: string | null;
  totalDebits: number;
  totalCredits: number;
  lineCount: number;
}

interface JournalLine {
  id: number;
  memo: string;
  glAccount: { id: number; code: string; name: string };
  debit: number;
  credit: number;
  sortOrder: number;
}

interface JournalEntryDetail extends Omit<JournalEntryListItem, "lineCount"> {
  lines: JournalLine[];
  notes: string | null;
}

interface ReconciliationResult {
  date: string;
  hasJournalEntry: boolean;
  source: { revenue: number; tax: number; cost: number; cash: number };
  journal: { revenue: number; tax: number; cost: number; cash: number };
  drift: { revenue: number; tax: number; cost: number; cash: number };
  balanced: boolean;
  warnings: string[];
}

type MoneyFormatter = ReturnType<typeof useMoneyFormatter>;

const STATUS_COLORS: Record<string, string> = {
  DRAFT: "bg-yellow-100 text-yellow-800",
  POSTED: "bg-blue-100 text-blue-800",
  EXPORTED: "bg-green-100 text-green-800",
};

// MM/DD/YYYY -- matches the legacy display AND the reconcile-panel guard, which
// compares the server's reconciliation.date string against this exact format.
function formatJournalDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });
}

function ReconciliationPanel({
  result,
  fmt,
}: Readonly<{ result: ReconciliationResult; fmt: MoneyFormatter }>) {
  return (
    <div className={`mb-4 p-3 rounded border text-sm ${reconciliationPanelClass(result.balanced)}`}>
      <div className="font-semibold mb-1">{reconciliationHeader(result)}</div>
      <table className="w-full text-xs mt-2">
        <thead className="text-sh-gray">
          <tr>
            <th className="text-left">Category</th>
            <th className="text-right">Source</th>
            <th className="text-right">Journal</th>
            <th className="text-right">Drift</th>
          </tr>
        </thead>
        <tbody>
          {RECONCILIATION_CATEGORIES.map((k: ReconciliationCategory) => (
            <tr key={k}>
              <td className="capitalize py-0.5">{k}</td>
              <td className="text-right font-mono">{fmt(result.source[k])}</td>
              <td className="text-right font-mono">{fmt(result.journal[k])}</td>
              <td className={`text-right font-mono ${driftCellClass(result.drift[k])}`}>
                {fmt(result.drift[k])}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {result.warnings.length > 0 && (
        <ul className="mt-2 list-disc pl-5 text-xs">
          {result.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EntryActions({
  entry,
  onExport,
  onStatusChange,
  onDelete,
}: Readonly<{
  entry: JournalEntryListItem;
  onExport: (id: number, format: string) => void;
  onStatusChange: (id: number, status: string) => void;
  onDelete: (id: number) => void;
}>) {
  return (
    <div className="flex gap-2">
      <button onClick={() => onExport(entry.id, "tab")} className="text-xs text-sh-blue underline">
        Export
      </button>
      {entry.status === "DRAFT" && (
        <>
          <button
            onClick={() => onStatusChange(entry.id, "POSTED")}
            className="text-xs text-sh-blue underline"
          >
            Post
          </button>
          <button onClick={() => onDelete(entry.id)} className="text-xs text-red-600 underline">
            Delete
          </button>
        </>
      )}
      {entry.status === "POSTED" && (
        <button
          onClick={() => onStatusChange(entry.id, "EXPORTED")}
          className="text-xs text-sh-blue underline"
        >
          Mark Exported
        </button>
      )}
    </div>
  );
}

export function JournalEntriesView() {
  const fmt = useMoneyFormatter();

  const [entries, setEntries] = useState<JournalEntryListItem[]>([]);
  const [selectedEntry, setSelectedEntry] = useState<JournalEntryDetail | null>(null);
  const [generateDate, setGenerateDate] = useState("");
  const [generating, setGenerating] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [reconciliation, setReconciliation] = useState<ReconciliationResult | null>(null);

  const fetchEntries = useCallback(async () => {
    const res = await fetch("/api/accounting/journal-entries");
    if (res.ok) setEntries(await res.json());
  }, []);

  useEffect(() => {
    fetchEntries();
  }, [fetchEntries]);

  const handleGenerate = async () => {
    if (!generateDate) {
      toast.error("Select a date");
      return;
    }
    setGenerating(true);
    try {
      const res = await fetch("/api/accounting/journal-entries/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: generateDate }),
      });
      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || "Generation failed");
        return;
      }

      if (data.warnings?.length) {
        data.warnings.forEach((w: string) => toast.warn(w));
      }

      toast.success(`Generated ${data.journalEntry.journalNumber}`);
      await fetchEntries();
      setSelectedEntry(data.journalEntry);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to generate journal entry"));
    } finally {
      setGenerating(false);
    }
  };

  const handleSelectEntry = async (id: number) => {
    if (selectedEntry?.id === id) {
      setSelectedEntry(null);
      return;
    }
    const res = await fetch(`/api/accounting/journal-entries/${id}`);
    if (res.ok) {
      setSelectedEntry(await res.json());
    }
  };

  const handleStatusChange = async (id: number, status: string) => {
    const res = await fetch(`/api/accounting/journal-entries/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (res.ok) {
      toast.success(`Status updated to ${status}`);
      await fetchEntries();
      if (selectedEntry?.id === id) {
        setSelectedEntry({ ...selectedEntry, status });
      }
    } else {
      const data = await res.json();
      toast.error(data.error || "Update failed");
    }
  };

  const handleDelete = async (id: number) => {
    const res = await fetch(`/api/accounting/journal-entries/${id}`, { method: "DELETE" });
    if (res.ok) {
      toast.success("Journal entry deleted");
      if (selectedEntry?.id === id) setSelectedEntry(null);
      await fetchEntries();
    } else {
      const data = await res.json();
      toast.error(data.error || "Delete failed");
    }
  };

  const handleExport = (id: number, format: string) => {
    globalThis.open(`/api/accounting/journal-entries/${id}/export?format=${format}`, "_blank");
  };

  const handleReconcile = async (id: number) => {
    setReconciling(true);
    setReconciliation(null);
    try {
      const res = await fetch(`/api/accounting/journal-entries/${id}/reconcile`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Reconciliation failed");
        return;
      }
      setReconciliation(data);
      if (data.balanced) {
        toast.success("Reconciliation balanced — JE matches source data");
      } else {
        toast.warn(`Reconciliation drift detected (${data.warnings.length} warning(s))`);
      }
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Reconciliation failed"));
    } finally {
      setReconciling(false);
    }
  };

  const showReconciliationPanel =
    selectedEntry !== null &&
    reconciliation?.date === formatJournalDate(selectedEntry.journalDate).toString();

  return (
    <div className="py-8 font-serif">
      <h1 className="text-2xl font-semibold text-sh-blue mb-6">Sales Journal Entries</h1>

      {/* Generate section */}
      <div className="bg-white border border-sh-gray/20 rounded-lg p-4 mb-6">
        <h2 className="text-lg font-semibold text-sh-blue mb-3">Generate Daily Sales Journal</h2>
        <div className="flex items-end gap-4">
          <div>
            <label htmlFor="generate-date" className="block text-sm text-sh-gray mb-1">
              Date
            </label>
            <input
              id="generate-date"
              type="date"
              value={generateDate}
              onChange={(e) => setGenerateDate(e.target.value)}
              className="border border-sh-gray/30 rounded px-3 py-2 text-sm font-serif"
            />
          </div>
          <Button onClick={handleGenerate} disabled={generating}>
            {generating ? "Generating..." : "Generate"}
          </Button>
        </div>
      </div>

      {/* Entries list */}
      <table className="w-full text-left mb-6">
        <thead>
          <tr className="border-b border-sh-gray/30">
            <th className="py-2 px-3 text-sh-gray text-sm font-medium">Journal #</th>
            <th className="py-2 px-3 text-sh-gray text-sm font-medium">Date</th>
            <th className="py-2 px-3 text-sh-gray text-sm font-medium text-center">Status</th>
            <th className="py-2 px-3 text-sh-gray text-sm font-medium text-right">Debits</th>
            <th className="py-2 px-3 text-sh-gray text-sm font-medium text-right">Credits</th>
            <th className="py-2 px-3 text-sh-gray text-sm font-medium text-center">Lines</th>
            <th className="py-2 px-3 text-sh-gray text-sm font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr
              key={e.id}
              onClick={() => handleSelectEntry(e.id)}
              className={`border-b border-sh-gray/10 cursor-pointer ${
                selectedEntry?.id === e.id ? "bg-sh-linen" : "hover:bg-sh-linen/50"
              }`}
            >
              <td className="py-2 px-3 font-medium">{e.journalNumber}</td>
              <td className="py-2 px-3">{formatJournalDate(e.journalDate)}</td>
              <td className="py-2 px-3 text-center">
                <span className={`text-xs px-2 py-0.5 rounded ${STATUS_COLORS[e.status] || ""}`}>
                  {e.status}
                </span>
              </td>
              <td className="py-2 px-3 text-right">{fmt(e.totalDebits)}</td>
              <td className="py-2 px-3 text-right">{fmt(e.totalCredits)}</td>
              <td className="py-2 px-3 text-center">{e.lineCount}</td>
              <td className="py-2 px-3" onClick={(ev) => ev.stopPropagation()}>
                <EntryActions
                  entry={e}
                  onExport={handleExport}
                  onStatusChange={handleStatusChange}
                  onDelete={handleDelete}
                />
              </td>
            </tr>
          ))}
          {entries.length === 0 && (
            <tr>
              <td colSpan={7} className="py-8 text-center text-sh-gray">
                No journal entries. Select a date and click Generate.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {/* Detail view */}
      {selectedEntry && (
        <div className="bg-white border border-sh-gray/20 rounded-lg p-4">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-semibold text-sh-blue">
              {selectedEntry.journalNumber} -- {formatJournalDate(selectedEntry.journalDate)}
            </h2>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                onClick={() => handleReconcile(selectedEntry.id)}
                disabled={reconciling}
                title="Cross-check this JE against the underlying source data (line items + payments). Catches generator drift before export."
              >
                {reconciling ? "Reconciling…" : "Reconcile against source"}
              </Button>
              <Button variant="secondary" onClick={() => handleExport(selectedEntry.id, "tab")}>
                Download Tab
              </Button>
              <Button variant="secondary" onClick={() => handleExport(selectedEntry.id, "csv")}>
                Download CSV
              </Button>
            </div>
          </div>

          {showReconciliationPanel && reconciliation && (
            <ReconciliationPanel result={reconciliation} fmt={fmt} />
          )}

          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-sh-gray/30">
                <th className="py-1.5 px-3 text-sh-gray font-medium">Memo</th>
                <th className="py-1.5 px-3 text-sh-gray font-medium">Acct #</th>
                <th className="py-1.5 px-3 text-sh-gray font-medium">Account Name</th>
                <th className="py-1.5 px-3 text-sh-gray font-medium text-right">Debit</th>
                <th className="py-1.5 px-3 text-sh-gray font-medium text-right">Credit</th>
              </tr>
            </thead>
            <tbody>
              {selectedEntry.lines.map((l) => (
                <tr key={l.id} className="border-b border-sh-gray/10">
                  <td className="py-1.5 px-3">{l.memo}</td>
                  <td className="py-1.5 px-3 font-mono text-xs">{l.glAccount.code}</td>
                  <td className="py-1.5 px-3 text-sh-gray">{l.glAccount.name}</td>
                  <td className="py-1.5 px-3 text-right">{l.debit > 0 ? fmt(l.debit) : ""}</td>
                  <td className="py-1.5 px-3 text-right">{l.credit > 0 ? fmt(l.credit) : ""}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-sh-blue font-semibold">
                <td colSpan={3} className="py-2 px-3 text-right">
                  Totals
                </td>
                <td className="py-2 px-3 text-right">{fmt(selectedEntry.totalDebits)}</td>
                <td className="py-2 px-3 text-right">{fmt(selectedEntry.totalCredits)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
