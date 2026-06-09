// /app/src/app/(dashboard)/app/admin/automations/axper-traffic/AxperTrafficView.tsx
//
// Client view for the Axper traffic-persistence cron. POSTs to
// /api/automations/axper-traffic-sync which kicks the work off in the
// background and returns a logId immediately (avoids nginx's 300s timeout for
// long backfills). The page then polls the recent-runs endpoint until the
// matching log row's `finishedAt` goes non-null, then renders the result
// inline.

"use client";

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { toast } from "react-toastify";
import { getErrorMessage } from "@/lib/toastError";

interface SyncLogRow {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  kind: string;
  dayFrom: string;
  dayTo: string;
  rowsFetched: number;
  rowsInserted: number;
  rowsUpdated: number;
  daysScanned: number;
  daysBackfilled: number;
  errors: string[];
  triggeredBy: string | null;
}

interface StartRunResponse {
  logId: number;
  status: "running";
  backfillWindowDays: number;
}

const POLL_INTERVAL_MS = 5_000;

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York" });
}

function fmtDuration(startedAt: string, finishedAt: string | null): string {
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const remSec = seconds % 60;
  return `${mins}m ${remSec}s`;
}

export function AxperTrafficView() {
  const [running, setRunning] = useState(false);
  /** ID of the currently in-flight job, if any. */
  const [activeLogId, setActiveLogId] = useState<number | null>(null);
  /** Result of the most-recent completed run, for the inline summary card. */
  const [lastCompleted, setLastCompleted] = useState<SyncLogRow | null>(null);
  const [recent, setRecent] = useState<SyncLogRow[]>([]);
  const [backfillDays, setBackfillDays] = useState<number>(30);
  /** Tick counter that bumps once per second while a job is running so
   *  the elapsed-time badge updates without re-fetching. */
  const [elapsedTick, setElapsedTick] = useState(0);

  const fetchRecent = useCallback(async (): Promise<SyncLogRow[]> => {
    try {
      const { data } = await axios.get<{ logs: SyncLogRow[] }>(
        "/api/admin/automations/axper-traffic/recent?limit=20",
      );
      setRecent(data.logs);
      return data.logs;
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to load recent runs"));
      return [];
    }
  }, []);

  useEffect(() => {
    fetchRecent();
  }, [fetchRecent]);

  // Poll while a job is running. Stops when the job's log row goes
  // finished (finishedAt !== null) OR when activeLogId clears.
  useEffect(() => {
    if (activeLogId === null) return;
    let cancelled = false;

    const poll = async () => {
      const logs = await fetchRecent();
      if (cancelled) return;
      const target = logs.find((l) => l.id === activeLogId);
      if (target && target.finishedAt !== null) {
        setActiveLogId(null);
        setRunning(false);
        setLastCompleted(target);
        if (target.errors.length === 0) {
          toast.success(
            `Synced. ${target.rowsFetched.toLocaleString()} fetched, ${target.rowsInserted.toLocaleString()} inserted, ${target.rowsUpdated.toLocaleString()} updated, ${target.daysScanned} days scanned.`,
          );
        } else {
          toast.error(
            `Sync finished with ${target.errors.length} error(s). See the recent-runs list.`,
          );
        }
      }
    };

    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [activeLogId, fetchRecent]);

  // Tick the elapsed-time display every second while running.
  useEffect(() => {
    if (activeLogId === null) return;
    const id = setInterval(() => setElapsedTick((t) => t + 1), 1_000);
    return () => clearInterval(id);
  }, [activeLogId]);

  async function handleRun() {
    setRunning(true);
    setLastCompleted(null);
    try {
      const { data } = await axios.post<StartRunResponse>("/api/automations/axper-traffic-sync", {
        backfillWindowDays: backfillDays,
      });
      setActiveLogId(data.logId);
      // Refresh the recent table immediately so the "running" row shows up.
      fetchRecent();
      toast.info(
        `Started ${data.backfillWindowDays}-day backfill (job #${data.logId}). This page will refresh when it finishes.`,
      );
    } catch (err) {
      toast.error(getErrorMessage(err, "Sync failed to start"));
      setRunning(false);
    }
  }

  // The "running" row, if any — what we poll for. Distinguishes
  // "this session kicked it off" (activeLogId) from "someone else's
  // job is still running" (no activeLogId but finishedAt === null).
  const inFlightRow = recent.find((l) => l.finishedAt === null);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-sh-navy">Axper Traffic Sync</h1>
        <p className="mt-1 text-sm text-sh-gray">
          Pulls yesterday&apos;s door-counter data from Axper into <code>TrafficSnapshot</code>,
          then scans the last N days and back-fills any missing days. Today&apos;s traffic is still
          pulled live by the dashboard charts (Axper closes the day at midnight, so the cron runs at
          02:00 ET against the previous day).
        </p>
        <p className="mt-1 text-xs text-sh-gray">
          The job runs in the background — you can navigate away and come back; the recent-runs
          table will show when it finishes.
        </p>
      </div>

      {/* Run Now */}
      <section className="rounded border border-sh-stripe bg-white p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="backfill-days" className="block text-xs font-medium text-sh-navy">
              Backfill window (days)
            </label>
            <input
              id="backfill-days"
              type="number"
              min={1}
              max={800}
              value={backfillDays}
              onChange={(e) =>
                setBackfillDays(Math.max(1, Math.min(800, Number(e.target.value) || 30)))
              }
              disabled={running}
              className="mt-1 w-24 rounded border border-gray-300 px-3 py-2 text-sm disabled:bg-sh-stripe"
            />
            <p className="mt-1 text-[11px] text-sh-gray">
              30 = default daily window. 730 = ~2-year historical backfill (one-time seed).
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              onClick={() => setBackfillDays(730)}
              variant="outline"
              disabled={running}
              title="Pull every day in the last ~2 years from Axper into the DB. Idempotent — re-running is a no-op on already-stored days."
            >
              Set 2-year backfill
            </Button>
            <Button onClick={handleRun} disabled={running}>
              {running ? "Running…" : "Run Now"}
            </Button>
          </div>
        </div>

        {/* Running banner */}
        {activeLogId !== null && inFlightRow && (
          <div className="mt-3 rounded border border-sh-gold/40 bg-sh-linen p-3 text-sm">
            <p className="font-medium text-sh-navy">
              Job #{activeLogId} running ({fmtDuration(inFlightRow.startedAt, null)}
              {/* elapsedTick keeps this re-rendering as the wall clock advances */}
              <span className="sr-only">{elapsedTick}</span>)
            </p>
            <p className="mt-1 text-xs text-sh-gray">
              Polling for completion every {POLL_INTERVAL_MS / 1000}s. A {backfillDays}-day backfill
              typically takes ~{Math.max(1, Math.round((backfillDays * 1) / 60))} min at ~1s per
              Axper API call.
            </p>
          </div>
        )}

        {/* Last-completed summary */}
        {lastCompleted && (
          <div className="mt-3 rounded border border-sh-stripe bg-sh-linen p-3 text-sm">
            <p className="font-medium text-sh-navy">
              Synced {lastCompleted.dayFrom.slice(0, 10)} – {lastCompleted.dayTo.slice(0, 10)} in{" "}
              {fmtDuration(lastCompleted.startedAt, lastCompleted.finishedAt)}
            </p>
            <ul className="mt-2 space-y-1 text-sh-gray">
              <li>Rows fetched: {lastCompleted.rowsFetched.toLocaleString()}</li>
              <li>Rows inserted: {lastCompleted.rowsInserted.toLocaleString()}</li>
              <li>Rows updated: {lastCompleted.rowsUpdated.toLocaleString()}</li>
              <li>Days scanned: {lastCompleted.daysScanned}</li>
              <li>Days backfilled: {lastCompleted.daysBackfilled}</li>
              {lastCompleted.errors.length > 0 && (
                <li className="text-red-700">
                  {lastCompleted.errors.length} error(s) — see recent-runs list for details
                </li>
              )}
            </ul>
          </div>
        )}
      </section>

      {/* Recent runs */}
      <section>
        <h2 className="mb-2 text-lg font-semibold text-sh-navy">Recent runs</h2>
        {recent.length === 0 ? (
          <p className="text-sm text-sh-gray">No runs yet.</p>
        ) : (
          <div className="overflow-x-auto rounded border border-sh-stripe bg-white">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-sh-linen text-sh-black">
                <tr>
                  <th className="p-2 font-medium">Started</th>
                  <th className="p-2 font-medium">Duration</th>
                  <th className="p-2 font-medium">Days</th>
                  <th className="p-2 font-medium text-right">Fetched</th>
                  <th className="p-2 font-medium text-right">Inserted</th>
                  <th className="p-2 font-medium text-right">Updated</th>
                  <th className="p-2 font-medium text-right">Backfilled</th>
                  <th className="p-2 font-medium">Trigger</th>
                  <th className="p-2 font-medium">Errors</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((log) => {
                  const isRunning = log.finishedAt === null;
                  return (
                    <tr
                      key={log.id}
                      className={`border-t border-sh-stripe ${isRunning ? "bg-sh-linen/40" : ""}`}
                    >
                      <td className="p-2 whitespace-nowrap">{fmtTime(log.startedAt)}</td>
                      <td className="p-2 text-xs whitespace-nowrap">
                        {isRunning ? (
                          <span className="text-sh-gold font-medium">
                            running… ({fmtDuration(log.startedAt, null)})
                            <span className="sr-only">{elapsedTick}</span>
                          </span>
                        ) : (
                          fmtDuration(log.startedAt, log.finishedAt)
                        )}
                      </td>
                      <td className="p-2 text-xs">
                        {log.dayFrom.slice(0, 10)} – {log.dayTo.slice(0, 10)}
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {log.rowsFetched.toLocaleString()}
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {log.rowsInserted.toLocaleString()}
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {log.rowsUpdated.toLocaleString()}
                      </td>
                      <td className="p-2 text-right tabular-nums">{log.daysBackfilled}</td>
                      <td className="p-2 text-xs">{log.triggeredBy ?? "—"}</td>
                      <td className="p-2 text-xs text-red-700">
                        {log.errors.length === 0 ? "—" : `${log.errors.length}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
