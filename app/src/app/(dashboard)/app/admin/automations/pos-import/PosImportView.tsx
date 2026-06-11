// /app/src/app/(dashboard)/app/admin/automations/pos-import/PosImportView.tsx
//
// Client view for the legacy-POS auto-import: health banner (staleness +
// unmapped stock locations), Run Now / Dry Run buttons, and the per-attachment
// AutoImportLog history with pagination.

"use client";

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { toast } from "react-toastify";
import { getErrorMessage } from "@/lib/toastError";

interface HealthResponse {
  lastSuccessfulRun: string | null;
  lastRun: string | null;
  lastRunStatus: string | null;
  hoursSinceSuccess: number | null;
  isStale: boolean;
  unmappedLocations: string[];
}

interface LogRow {
  id: number;
  runId: string;
  emailSubject: string | null;
  filename: string;
  importType: string;
  status: string;
  recordCount: number | null;
  errorMessage: string | null;
  created: string;
}

interface HistoryResponse {
  logs: LogRow[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

interface RunSummary {
  runId: string;
  dryRun: boolean;
  emailsProcessed: number;
  emailsSkipped: number;
  imports: { filename: string; importType: string; status: string; recordCount: number }[];
  errors: string[];
  message?: string;
}

const STATUS_STYLES: Record<string, string> = {
  success: "bg-green-100 text-green-800",
  error: "bg-red-100 text-red-800",
  skipped: "bg-gray-100 text-gray-600",
  "dry-run": "bg-blue-100 text-blue-800",
};

function formatWhen(iso: string | null): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleString();
}

export function PosImportView() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [page, setPage] = useState(1);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<RunSummary | null>(null);

  const refresh = useCallback(async (p: number) => {
    try {
      const [healthRes, historyRes] = await Promise.all([
        axios.get<HealthResponse>("/api/automations/import-health"),
        axios.get<HistoryResponse>(`/api/automations/import-history?page=${p}&limit=25`),
      ]);
      setHealth(healthRes.data);
      setHistory(historyRes.data);
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to load import status"));
    }
  }, []);

  useEffect(() => {
    void refresh(page);
  }, [refresh, page]);

  const runNow = async (dryRun: boolean) => {
    setRunning(true);
    setLastRun(null);
    try {
      const res = await axios.post<RunSummary>(
        `/api/automations/gmail-import${dryRun ? "?dryRun=true" : ""}`,
      );
      setLastRun(res.data);
      if (res.data.errors.length > 0) {
        toast.warn(`Run finished with ${res.data.errors.length} error(s) — see below`);
      } else {
        toast.success(
          res.data.message ||
            `${dryRun ? "Dry run" : "Import"} complete — ${res.data.imports.length} file(s)`,
        );
      }
      await refresh(1);
      setPage(1);
    } catch (err) {
      toast.error(getErrorMessage(err, "Import run failed"));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Legacy POS auto-import</h1>
          <p className="text-sm text-muted-foreground">
            Daily ingestion of the legacy POS&apos;s emailed CSV reports. The cron runs every
            morning; use Run Now after fixing a failed file.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" disabled={running} onClick={() => runNow(true)}>
            Dry run
          </Button>
          <Button disabled={running} onClick={() => runNow(false)}>
            {running ? "Running…" : "Run now"}
          </Button>
        </div>
      </div>

      {health && (
        <div
          className={`rounded-md border p-4 text-sm ${
            health.isStale ? "border-amber-300 bg-amber-50" : "border-green-200 bg-green-50"
          }`}
        >
          <p>
            Last successful run: <strong>{formatWhen(health.lastSuccessfulRun)}</strong>
            {health.hoursSinceSuccess !== null && ` (${health.hoursSinceSuccess}h ago)`}
            {health.isStale && " — STALE: no success in 24h, check the cron + Gmail label."}
          </p>
          <p>
            Last run: {formatWhen(health.lastRun)}
            {health.lastRunStatus && ` (${health.lastRunStatus})`}
          </p>
          {health.unmappedLocations.length > 0 && (
            <p className="mt-2 text-amber-800">
              Unmapped stock locations from the last stock import (add aliases in Inventory →
              Locations): {health.unmappedLocations.join(", ")}
            </p>
          )}
        </div>
      )}

      {lastRun && (
        <div className="rounded-md border p-4 text-sm">
          <p className="font-medium">
            {lastRun.dryRun ? "Dry run" : "Run"} {lastRun.runId.slice(0, 8)} — emails processed:{" "}
            {lastRun.emailsProcessed}, skipped: {lastRun.emailsSkipped}
          </p>
          {lastRun.imports.length > 0 && (
            <ul className="mt-2 space-y-1">
              {lastRun.imports.map((imp, i) => (
                <li key={`${imp.filename}-${i}`}>
                  <span
                    className={`mr-2 rounded px-1.5 py-0.5 text-xs ${STATUS_STYLES[imp.status] ?? ""}`}
                  >
                    {imp.status}
                  </span>
                  {imp.filename} → {imp.importType} ({imp.recordCount} records)
                </li>
              ))}
            </ul>
          )}
          {lastRun.errors.length > 0 && (
            <ul className="mt-2 space-y-1 text-red-700">
              {lastRun.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div>
        <h2 className="mb-2 text-lg font-medium">Import history</h2>
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">File</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Records</th>
                <th className="px-3 py-2">Error</th>
              </tr>
            </thead>
            <tbody>
              {(history?.logs ?? []).map((log) => (
                <tr key={log.id} className="border-t">
                  <td className="whitespace-nowrap px-3 py-2">{formatWhen(log.created)}</td>
                  <td className="px-3 py-2">{log.filename}</td>
                  <td className="px-3 py-2">{log.importType}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs ${STATUS_STYLES[log.status] ?? ""}`}
                    >
                      {log.status}
                    </span>
                  </td>
                  <td className="px-3 py-2">{log.recordCount ?? ""}</td>
                  <td
                    className="max-w-md truncate px-3 py-2 text-red-700"
                    title={log.errorMessage ?? ""}
                  >
                    {log.errorMessage ?? ""}
                  </td>
                </tr>
              ))}
              {history && history.logs.length === 0 && (
                <tr>
                  <td className="px-3 py-4 text-muted-foreground" colSpan={6}>
                    No import runs logged yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {history && history.pagination.totalPages > 1 && (
          <div className="mt-2 flex items-center gap-2 text-sm">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              Previous
            </Button>
            <span>
              Page {history.pagination.page} of {history.pagination.totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= history.pagination.totalPages}
              onClick={() => setPage(page + 1)}
            >
              Next
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
