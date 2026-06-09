"use client";

// /app/src/app/(dashboard)/app/admin/import/service-cases/ServiceCasesImportView.tsx
//
// Customer Service Sheet import body. App Router port of the legacy
// admin/import/service-cases body (minus MainLayout chrome, which the
// (dashboard) layout supplies). Two-step flow: upload with dry-run ON to preview
// what would change, then re-upload with dry-run OFF to write. Re-uploads are
// idempotent (externalSourceId); a grown sheet syncs only the deltas. Posts the
// .xlsx as multipart to the shared /api/admin/service/import-sheet REST endpoint.

import { useEffect, useState, type ChangeEvent } from "react";
import Link from "next/link";
import { toast } from "react-toastify";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";

interface UnmatchedRow {
  rowKey: string;
  sheetName: string;
  rowNumber: number;
  name: string;
  ordernoRaw?: string;
  reason: string;
}

interface ImportResult {
  parsed: { rows: number; notes: number; warnings: string[] };
  casesCreated: number;
  casesUpdated: number;
  notesCreated: number;
  notesSkipped: number;
  unmatched: UnmatchedRow[];
  errors: string[];
  elapsedMs: number;
  dryRun: boolean;
}

interface LastSync {
  importedCaseCount: number;
  lastSyncAt: string | null;
}

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function copyText(s: string) {
  navigator.clipboard.writeText(s).then(
    () => toast.success("Copied to clipboard"),
    () => toast.error("Copy failed"),
  );
}

function buttonLabel(running: boolean, dryRun: boolean): string {
  if (running) return "Importing…";
  return dryRun ? "Run dry-run" : "Import for real";
}

function unmatchedAsTsv(rows: UnmatchedRow[]): string {
  return rows
    .map((u) => `${u.sheetName}!${u.rowNumber}\t${u.name}\t${u.ordernoRaw ?? ""}\t${u.reason}`)
    .join("\n");
}

export function ServiceCasesImportView() {
  const [file, setFile] = useState<File | null>(null);
  const [dryRun, setDryRun] = useState(true);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [lastSync, setLastSync] = useState<LastSync | null>(null);

  useEffect(() => {
    void axios
      .get<LastSync>("/api/admin/service/import-sheet")
      .then((r) => setLastSync(r.data))
      .catch(() => {
        // Endpoint may 401 in odd auth states; ignore.
      });
  }, []);

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    setResult(null);
  };

  const handleSubmit = async () => {
    if (!file) {
      toast.error("Pick a .xlsx file first.");
      return;
    }
    setRunning(true);
    setResult(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("dryRun", dryRun ? "true" : "false");
      const res = await axios.post<ImportResult>("/api/admin/service/import-sheet", form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      setResult(res.data);
      const r = res.data;
      if (r.dryRun) {
        toast.success(
          `Dry-run: ${r.casesCreated} create + ${r.casesUpdated} update, ${r.notesCreated} new notes`,
        );
      } else {
        toast.success(
          `Imported: ${r.casesCreated} created, ${r.casesUpdated} updated, ${r.notesCreated} notes`,
        );
        // Refresh last-sync indicator
        void axios
          .get<LastSync>("/api/admin/service/import-sheet")
          .then((r2) => setLastSync(r2.data));
      }
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Import failed"));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="max-w-screen-lg mx-auto px-4 py-6 space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-3xl font-serif text-sh-navy">Import Customer Service Sheet</h1>
        <Link href="/app/service" className="text-sm text-sh-gold hover:underline">
          ← Service module
        </Link>
      </div>

      <p className="text-sh-gray">
        Upload the latest <code>Updated Customer Service Sheet.xlsx</code>. The importer reads the
        &quot;C.S. In process&quot;, &quot;C.S. Completed&quot;, and &quot;Repair&quot; tabs;
        threaded cell comments become individual notes on the matching ServiceCase. Re-uploading the
        same file is a no-op; only new rows + new comment threads are written.
      </p>

      <div className="rounded border border-sh-stripe bg-white p-4 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-sh-gray">Imported cases on file</span>
          <span className="font-medium text-sh-navy">{lastSync?.importedCaseCount ?? "—"}</span>
        </div>
        <div className="mt-1 flex items-center justify-between">
          <span className="text-sh-gray">Last sync</span>
          <span className="font-medium text-sh-navy">{formatWhen(lastSync?.lastSyncAt)}</span>
        </div>
      </div>

      <div className="rounded border border-sh-stripe bg-white p-6 space-y-4">
        <div>
          <label htmlFor="cs-sheet-file" className="block text-sm font-medium text-sh-navy">
            Customer Service Sheet (.xlsx)
          </label>
          <input
            id="cs-sheet-file"
            type="file"
            accept=".xlsx"
            onChange={handleFileChange}
            className="mt-2 block w-full text-sm"
          />
          {file && (
            <p className="mt-1 text-xs text-sh-gray">
              Selected: <span className="font-mono">{file.name}</span> (
              {Math.round(file.size / 1024)} KB)
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          <input
            id="cs-sheet-dryrun"
            type="checkbox"
            checked={dryRun}
            onChange={(e) => setDryRun(e.target.checked)}
            className="h-4 w-4"
          />
          <label htmlFor="cs-sheet-dryrun" className="text-sm text-sh-navy">
            Dry-run only (no writes — see what would change)
          </label>
        </div>

        <Button onClick={handleSubmit} disabled={!file || running}>
          {buttonLabel(running, dryRun)}
        </Button>
      </div>

      {result && (
        <div className="rounded border border-sh-stripe bg-white p-6 space-y-4">
          <h2 className="text-xl font-serif text-sh-navy">
            {result.dryRun ? "Dry-run results" : "Import complete"}
          </h2>

          <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
            <ResultStat label="Rows parsed" value={result.parsed.rows} />
            <ResultStat label="Comments parsed" value={result.parsed.notes} />
            <ResultStat label="Cases created" value={result.casesCreated} />
            <ResultStat label="Cases updated" value={result.casesUpdated} />
            <ResultStat label="Notes created" value={result.notesCreated} />
            <ResultStat label="Notes already there" value={result.notesSkipped} />
            <ResultStat label="Unmatched" value={result.unmatched.length} />
            <ResultStat
              label="Errors"
              value={result.errors.length}
              isError={result.errors.length > 0}
            />
          </div>

          {result.parsed.warnings.length > 0 && (
            <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm">
              <div className="font-medium text-amber-900">Parser warnings</div>
              <ul className="mt-2 list-disc pl-5 text-amber-900">
                {result.parsed.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {result.errors.length > 0 && (
            <div className="rounded border border-red-300 bg-red-50 p-3 text-sm">
              <div className="font-medium text-red-900">Errors</div>
              <ul className="mt-2 list-disc pl-5 text-red-900">
                {result.errors.slice(0, 25).map((e) => (
                  <li key={e}>{e}</li>
                ))}
                {result.errors.length > 25 && <li>…and {result.errors.length - 25} more</li>}
              </ul>
            </div>
          )}

          {result.unmatched.length > 0 && (
            <div>
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-sh-navy">
                  Unmatched rows ({result.unmatched.length})
                </h3>
                <button
                  type="button"
                  onClick={() => copyText(unmatchedAsTsv(result.unmatched))}
                  className="text-xs text-sh-gold hover:underline"
                >
                  Copy as TSV
                </button>
              </div>
              <div className="mt-2 overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-sh-stripe">
                    <tr>
                      <th className="px-3 py-2 text-left">Sheet · row</th>
                      <th className="px-3 py-2 text-left">Name</th>
                      <th className="px-3 py-2 text-left">Order #</th>
                      <th className="px-3 py-2 text-left">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.unmatched.slice(0, 100).map((u) => (
                      <tr key={u.rowKey} className="border-t border-sh-stripe">
                        <td className="px-3 py-2 whitespace-nowrap font-mono text-xs">
                          {u.sheetName} · {u.rowNumber}
                        </td>
                        <td className="px-3 py-2">{u.name}</td>
                        <td className="px-3 py-2 font-mono text-xs">{u.ordernoRaw ?? ""}</td>
                        <td className="px-3 py-2 text-sh-gray">{u.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {result.unmatched.length > 100 && (
                  <p className="mt-2 text-xs text-sh-gray">
                    Showing first 100. Copy-as-TSV for the full list.
                  </p>
                )}
              </div>
            </div>
          )}

          <p className="text-xs text-sh-gray">Elapsed: {(result.elapsedMs / 1000).toFixed(1)}s</p>
        </div>
      )}
    </div>
  );
}

function ResultStat({
  label,
  value,
  isError = false,
}: Readonly<{ label: string; value: number; isError?: boolean }>) {
  return (
    <div>
      <div className="text-sh-gray">{label}</div>
      <div className={`text-2xl font-medium ${isError ? "text-red-600" : "text-sh-navy"}`}>
        {value}
      </div>
    </div>
  );
}
