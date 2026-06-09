// /app/src/app/(dashboard)/app/admin/automations/daily-reconciliation/DailyReconciliationView.tsx
//
// Client view for the daily JE-vs-source reconciliation cron. POSTs to
// /api/automations/daily-reconciliation and renders the per-day breakdown
// inline. Reads recent DailyReconciliationLog rows for context.

"use client";

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { toast } from "react-toastify";
import { getErrorMessage } from "@/lib/toastError";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";

type ReconStatus = "BALANCED" | "DRIFT" | "ERROR";

interface PerDayResult {
  date: string;
  status: ReconStatus;
  drift: { revenue: number; tax: number; cost: number; cash: number };
  warnings: string[];
  journalEntryId: number | null;
  logId: number;
}

interface RunResponse {
  runId: string;
  daysReconciled: number;
  daysBalanced: number;
  daysWithDrift: number;
  daysWithError: number;
  results: PerDayResult[];
  errors: string[];
}

interface RecentLogRow {
  id: number;
  date: string;
  balanced: boolean;
  driftRevenue: number;
  driftTax: number;
  driftCost: number;
  driftCash: number;
  warnings: string[];
  journalEntryId: number | null;
  created: string;
}

function statusColor(status: ReconStatus): string {
  if (status === "BALANCED") return "bg-green-100 text-green-800";
  if (status === "DRIFT") return "bg-amber-100 text-amber-900";
  return "bg-red-100 text-red-800";
}

export function DailyReconciliationView() {
  const formatMoney = useMoneyFormatter();
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState<RunResponse | null>(null);
  const [recent, setRecent] = useState<RecentLogRow[]>([]);
  // Optional date range — leave blank to run "yesterday in ET"
  const [date, setDate] = useState<string>("");
  const [start, setStart] = useState<string>("");
  const [end, setEnd] = useState<string>("");

  const fetchRecent = useCallback(async () => {
    try {
      const { data } = await axios.get<{ logs: RecentLogRow[] }>(
        "/api/admin/automations/daily-reconciliation/recent",
      );
      setRecent(data.logs ?? []);
    } catch {
      // Surfacing on initial load fail isn't critical — the page still works
    }
  }, []);

  useEffect(() => {
    fetchRecent();
  }, [fetchRecent]);

  async function handleRun() {
    setRunning(true);
    setRun(null);
    try {
      const body: Record<string, string> = {};
      if (date) body.date = date;
      else if (start && end) {
        body.start = start;
        body.end = end;
      }
      const { data } = await axios.post<RunResponse>("/api/automations/daily-reconciliation", body);
      setRun(data);
      const driftCount = data.daysWithDrift + data.daysWithError;
      if (driftCount === 0) {
        toast.success(`${data.daysReconciled} day(s) reconciled — all balanced`);
      } else {
        toast.warn(`${data.daysReconciled} reconciled, ${driftCount} need attention`);
      }
      fetchRecent();
    } catch (err) {
      toast.error(getErrorMessage(err, "Daily reconciliation failed"));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="mx-auto max-w-screen-lg space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold text-sh-navy">Daily Reconciliation</h1>
        <p className="text-sm text-sh-gray">
          Cross-checks the day&apos;s generated JournalEntry against the underlying source data
          (OrderLineItem + Payment totals). Drift &gt; $0.01 means the JE will misrepresent what
          actually happened. This is Phase 0 control C1.
        </p>
        <p className="text-sm text-sh-gray">
          Cron triggers this nightly via{" "}
          <code className="rounded bg-sh-stripe px-1">/api/automations/daily-reconciliation</code>{" "}
          (default: yesterday in America/New_York). Below you can manually run a specific date or a
          range.
        </p>
      </header>

      {/* Run controls */}
      <section className="rounded border border-gray-200 bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-lg font-medium text-sh-navy">Run a reconciliation</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor="single-date" className="block text-xs font-medium text-sh-navy">
              Single date
            </label>
            <input
              id="single-date"
              type="date"
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                if (e.target.value) {
                  setStart("");
                  setEnd("");
                }
              }}
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm"
            />
          </div>
          <div>
            <label htmlFor="range-start" className="block text-xs font-medium text-sh-navy">
              Range start
            </label>
            <input
              id="range-start"
              type="date"
              value={start}
              onChange={(e) => {
                setStart(e.target.value);
                if (e.target.value) setDate("");
              }}
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm"
            />
          </div>
          <div>
            <label htmlFor="range-end" className="block text-xs font-medium text-sh-navy">
              Range end
            </label>
            <input
              id="range-end"
              type="date"
              value={end}
              onChange={(e) => {
                setEnd(e.target.value);
                if (e.target.value) setDate("");
              }}
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm"
            />
          </div>
        </div>
        <p className="mt-2 text-xs text-sh-gray">Leave all blank to reconcile yesterday (ET).</p>
        <div className="mt-3">
          <Button onClick={handleRun} disabled={running}>
            {running ? "Reconciling…" : "Run reconciliation"}
          </Button>
        </div>
      </section>

      {/* Run result */}
      {run && (
        <section className="rounded border border-gray-200 bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-lg font-medium text-sh-navy">
            Run {run.runId} — {run.daysReconciled} day(s)
          </h2>
          <div className="mb-3 flex gap-2 text-sm">
            <span className="rounded bg-green-100 px-2 py-0.5 text-green-800">
              {run.daysBalanced} balanced
            </span>
            <span className="rounded bg-amber-100 px-2 py-0.5 text-amber-900">
              {run.daysWithDrift} drift
            </span>
            <span className="rounded bg-red-100 px-2 py-0.5 text-red-800">
              {run.daysWithError} error
            </span>
          </div>
          <table className="w-full text-sm">
            <thead className="text-sh-navy">
              <tr>
                <th className="px-2 py-1 text-left">Date</th>
                <th className="px-2 py-1 text-left">Status</th>
                <th className="px-2 py-1 text-right">Δ Revenue</th>
                <th className="px-2 py-1 text-right">Δ Tax</th>
                <th className="px-2 py-1 text-right">Δ Cost</th>
                <th className="px-2 py-1 text-right">Δ Cash</th>
                <th className="px-2 py-1 text-left">JE</th>
              </tr>
            </thead>
            <tbody>
              {run.results.map((r) => (
                <tr key={r.logId} className="border-t border-gray-100">
                  <td className="px-2 py-1">{r.date}</td>
                  <td className="px-2 py-1">
                    <span className={`rounded px-2 py-0.5 ${statusColor(r.status)}`}>
                      {r.status}
                    </span>
                  </td>
                  <td className="px-2 py-1 text-right">{formatMoney(r.drift.revenue)}</td>
                  <td className="px-2 py-1 text-right">{formatMoney(r.drift.tax)}</td>
                  <td className="px-2 py-1 text-right">{formatMoney(r.drift.cost)}</td>
                  <td className="px-2 py-1 text-right">{formatMoney(r.drift.cash)}</td>
                  <td className="px-2 py-1">{r.journalEntryId ? `#${r.journalEntryId}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {run.errors.length > 0 && (
            <div className="mt-3 rounded border border-red-200 bg-red-50 p-3 text-xs">
              <strong>Errors:</strong>
              <ul className="ml-5 list-disc">
                {run.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {/* Recent runs */}
      <section className="rounded border border-gray-200 bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-lg font-medium text-sh-navy">Recent (last 30 days)</h2>
        {recent.length === 0 ? (
          <p className="text-sm text-sh-gray">No reconciliations on record yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-sh-navy">
              <tr>
                <th className="px-2 py-1 text-left">Date</th>
                <th className="px-2 py-1 text-left">Balanced</th>
                <th className="px-2 py-1 text-right">Drift (max abs $)</th>
                <th className="px-2 py-1 text-left">JE</th>
                <th className="px-2 py-1 text-left">When</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r) => {
                const maxAbs = Math.max(
                  Math.abs(r.driftRevenue),
                  Math.abs(r.driftTax),
                  Math.abs(r.driftCost),
                  Math.abs(r.driftCash),
                );
                return (
                  <tr key={r.id} className="border-t border-gray-100">
                    <td className="px-2 py-1">{r.date.slice(0, 10)}</td>
                    <td className="px-2 py-1">
                      <span
                        className={`rounded px-2 py-0.5 ${
                          r.balanced ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-900"
                        }`}
                      >
                        {r.balanced ? "YES" : "NO"}
                      </span>
                    </td>
                    <td className="px-2 py-1 text-right">{formatMoney(maxAbs)}</td>
                    <td className="px-2 py-1">{r.journalEntryId ? `#${r.journalEntryId}` : "—"}</td>
                    <td className="px-2 py-1 text-xs text-sh-gray">
                      {new Date(r.created).toLocaleString()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
