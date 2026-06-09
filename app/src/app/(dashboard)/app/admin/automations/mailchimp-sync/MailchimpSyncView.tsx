// /app/src/app/(dashboard)/app/admin/automations/mailchimp-sync/MailchimpSyncView.tsx
//
// Client view for the automated Mailchimp sync. Shows the last-run summary, a
// "Run All Steps" button plus per-phase buttons, a backfill/repair panel, a
// new-customer audience sync panel, and a paginated run history. The legacy
// 623-line page is decomposed here into focused sub-components, each owning one
// card, to keep cognitive complexity low.

"use client";

import { useState, useEffect, useCallback } from "react";
import axios from "axios";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { toast } from "react-toastify";
import { getErrorMessage } from "@/lib/toastError";

// --- Shared types -----------------------------------------------------------

interface LastRun {
  runId: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  campaignsUpserted: number;
  metricsUpdated: number;
  activitiesInserted: number;
  leadsCreated: number;
  leadsUpdated: number;
  errors: string[];
}

interface Health {
  lastRun: LastRun | null;
  lastSuccessAt: string | null;
  isStale: boolean;
  hoursSinceSuccess: number | null;
}

interface SyncLogRow {
  id: number;
  runId: string;
  kind: string;
  status: string;
  campaignsUpserted: number;
  metricsUpdated: number;
  activitiesInserted: number;
  leadsCreated: number;
  leadsUpdated: number;
  leadsArchived: number;
  errors: string[];
  startedAt: string;
  finishedAt: string | null;
  created: string;
}

type Phase = "campaigns" | "metrics" | "activity" | "ingest-leads";

interface PhaseResult {
  status: string;
  campaignsUpserted: number;
  metricsUpdated: number;
  activitiesInserted: number;
  leadsCreated: number;
  leadsUpdated: number;
  durationMs: number;
  errors: string[];
}

interface PhaseProgress {
  phase: Phase;
  result?: PhaseResult;
  error?: string;
}

// --- Constants + pure helpers ----------------------------------------------

const PAGE_SIZE = 25;
const PHASES: readonly Phase[] = ["campaigns", "metrics", "activity", "ingest-leads"];

const PHASE_LABEL: Record<Phase, string> = {
  campaigns: "Sync Campaigns",
  metrics: "Sync Metrics",
  activity: "Sync Activity",
  "ingest-leads": "Ingest Leads",
};

const PHASE_DESC: Record<Phase, string> = {
  campaigns: "Pull new campaigns from Mailchimp (fast, ~1s)",
  metrics: "Refresh open/click counts for campaigns sent in the last 30 days (~1–2 min)",
  activity:
    "Fetch per-recipient open/click activity for campaigns sent in the last 14 days (slowest; can take 3–10 min)",
  "ingest-leads": "Convert recent activity into leads (fast, ~5s)",
};

const STATUS_PILL: Record<string, string> = {
  SUCCESS: "bg-green-50 text-green-700 border-green-200",
  PARTIAL: "bg-amber-50 text-amber-700 border-amber-200",
  FAILED: "bg-red-50 text-red-700 border-red-200",
};

function fmtDateTime(s: string | null): string {
  if (!s) return "—";
  return new Date(s).toLocaleString();
}

function fmtDuration(startedAt: string, finishedAt: string | null): string {
  if (!finishedAt) return "—";
  return fmtMs(new Date(finishedAt).getTime() - new Date(startedAt).getTime());
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

/** One-line toast summary for a finished phase (replaces a nested ternary). */
function phaseSummary(phase: Phase, r: PhaseResult): string {
  switch (phase) {
    case "campaigns":
      return `${r.campaignsUpserted} campaigns`;
    case "metrics":
      return `${r.metricsUpdated} campaigns updated`;
    case "activity":
      return `${r.activitiesInserted} activity records`;
    case "ingest-leads":
      return `${r.leadsCreated} leads created, ${r.leadsUpdated} updated`;
  }
}

/** Detail line under a phase card after it runs (replaces inline `&&` chains). */
function phaseProgressDetail(phase: Phase, r: PhaseResult): string {
  switch (phase) {
    case "campaigns":
      return `${r.campaignsUpserted} campaigns upserted`;
    case "metrics":
      return `${r.metricsUpdated} campaign(s) updated`;
    case "activity":
      return `${r.activitiesInserted} activity records`;
    case "ingest-leads":
      return `${r.leadsCreated} leads created, ${r.leadsUpdated} updated`;
  }
}

/** History-row summary differs for the lead-housekeeping kind. */
function historySummary(r: SyncLogRow): string {
  if (r.kind === "mailchimp-sync") {
    return `${r.campaignsUpserted} camp · ${r.metricsUpdated} metrics · ${r.activitiesInserted} act · ${r.leadsCreated}+ / ${r.leadsUpdated}↻ leads`;
  }
  return `${r.leadsArchived} archived`;
}

// --- Root view --------------------------------------------------------------

export function MailchimpSyncView() {
  const [health, setHealth] = useState<Health | null>(null);
  const [history, setHistory] = useState<SyncLogRow[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [activePhase, setActivePhase] = useState<Phase | "all" | null>(null);
  const [loading, setLoading] = useState(true);
  const [allProgress, setAllProgress] = useState<PhaseProgress[]>([]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [hRes, histRes] = await Promise.all([
        axios.get<Health>("/api/automations/mailchimp-health"),
        axios.get<{ rows: SyncLogRow[]; total: number }>(
          `/api/automations/mailchimp-history?page=${page}&limit=${PAGE_SIZE}`,
        ),
      ]);
      setHealth(hRes.data);
      setHistory(histRes.data.rows);
      setTotal(histRes.data.total);
    } catch {
      toast.error("Failed to load automation status.");
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const runPhase = useCallback(async (phase: Phase): Promise<PhaseResult> => {
    const res = await axios.post<PhaseResult>(
      `/api/automations/mailchimp-sync?phase=${phase}`,
      {},
      { timeout: 30 * 60 * 1000 }, // 30 min ceiling so activity syncs don't get client-killed
    );
    return res.data;
  }, []);

  async function runSinglePhase(phase: Phase) {
    setActivePhase(phase);
    try {
      const r = await runPhase(phase);
      if (r.status === "FAILED") {
        toast.error(`${PHASE_LABEL[phase]} failed: ${r.errors.join(", ") || "see logs"}`);
      } else {
        toast.success(
          `${PHASE_LABEL[phase]} ${r.status}: ${phaseSummary(phase, r)} · ${fmtMs(r.durationMs)}`,
        );
      }
      await loadAll();
    } catch (err) {
      toast.error(getErrorMessage(err, `${PHASE_LABEL[phase]} request failed`));
    } finally {
      setActivePhase(null);
    }
  }

  async function runAll() {
    setActivePhase("all");
    setAllProgress([]);
    for (const p of PHASES) {
      setAllProgress((prev) => [...prev, { phase: p }]);
      try {
        const r = await runPhase(p);
        setAllProgress((prev) => prev.map((x) => (x.phase === p ? { ...x, result: r } : x)));
      } catch (err) {
        const msg = getErrorMessage(err, "request failed");
        setAllProgress((prev) => prev.map((x) => (x.phase === p ? { ...x, error: msg } : x)));
        toast.error(`${PHASE_LABEL[p]} failed: ${msg}`);
        // Continue to next phase — one failure shouldn't abort the rest
      }
    }
    setActivePhase(null);
    toast.success("Run All complete.");
    await loadAll();
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="py-2 space-y-6 font-serif">
      <div className="flex items-center gap-3">
        <Link href="/app/admin" className="text-sh-blue hover:underline text-sm">
          Admin
        </Link>
        <span className="text-sh-gray">/</span>
        <h1 className="text-2xl font-semibold text-sh-blue">Mailchimp Sync</h1>
      </div>

      <p className="text-sm text-sh-gray">
        Pulls new campaigns, updates metrics, fetches open/click activity for recent campaigns, and
        turns clicks (plus opens from high-value customers) into leads. Runs automatically once a
        day on the Synology. Below are individual buttons per phase — they can be run independently
        if you need to refresh just one part, or hit &quot;Run All Steps&quot; to do the full
        pipeline sequentially with live progress.
      </p>

      <LastRunCard health={health} loading={loading} />

      <PhaseStepsCard
        activePhase={activePhase}
        allProgress={allProgress}
        onRunAll={runAll}
        onRunPhase={runSinglePhase}
      />

      <BackfillPanel />

      <CustomerSyncPanel />

      <HistoryTable
        history={history}
        loading={loading}
        total={total}
        page={page}
        totalPages={totalPages}
        onPrev={() => setPage((p) => Math.max(1, p - 1))}
        onNext={() => setPage((p) => Math.min(totalPages, p + 1))}
      />
    </div>
  );
}

// --- Last-run status card ---------------------------------------------------

function LastRunCard({ health, loading }: Readonly<{ health: Health | null; loading: boolean }>) {
  let body: React.ReactNode;
  if (loading) {
    body = <p className="text-sh-gray">Loading…</p>;
  } else if (!health?.lastRun) {
    body = <p className="text-sh-gray italic">Never run. Use the buttons below to start.</p>;
  } else {
    const lastRun = health.lastRun;
    body = (
      <>
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={`inline-block px-2 py-0.5 text-xs font-semibold rounded-full border ${STATUS_PILL[lastRun.status] ?? ""}`}
          >
            {lastRun.status}
          </span>
          <span className="text-sm text-sh-black">{fmtDateTime(lastRun.finishedAt)}</span>
          {health.isStale && (
            <span className="inline-block px-2 py-0.5 text-xs font-semibold rounded-full border bg-amber-50 text-amber-700 border-amber-200">
              Stale · {health.hoursSinceSuccess}h since last success
            </span>
          )}
        </div>
        <p className="text-xs text-sh-gray">
          {lastRun.campaignsUpserted} campaigns · {lastRun.metricsUpdated} metrics ·{" "}
          {lastRun.activitiesInserted} activities · {lastRun.leadsCreated} leads created,{" "}
          {lastRun.leadsUpdated} updated
        </p>
        {lastRun.errors.length > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-2 text-xs text-amber-800">
            <strong>Errors:</strong>
            <ul className="list-disc ml-4">
              {lastRun.errors.slice(0, 5).map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        )}
      </>
    );
  }

  return (
    <div className="bg-white border border-sh-gray/20 rounded-lg p-5 space-y-2">
      <p className="text-xs uppercase tracking-wide text-sh-gray">Last run</p>
      {body}
    </div>
  );
}

// --- Phase steps card -------------------------------------------------------

function PhaseStepsCard({
  activePhase,
  allProgress,
  onRunAll,
  onRunPhase,
}: Readonly<{
  activePhase: Phase | "all" | null;
  allProgress: PhaseProgress[];
  onRunAll: () => void;
  onRunPhase: (phase: Phase) => void;
}>) {
  return (
    <div className="bg-white border border-sh-gray/20 rounded-lg p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-sh-black">Sync steps</h2>
        <Button onClick={onRunAll} disabled={activePhase !== null} className="min-h-[40px] px-5">
          {activePhase === "all" ? "Running…" : "Run All Steps"}
        </Button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {PHASES.map((p) => (
          <PhaseRow
            key={p}
            phase={p}
            progress={allProgress.find((x) => x.phase === p)}
            isActive={activePhase === p}
            disabled={activePhase !== null}
            onRun={() => onRunPhase(p)}
          />
        ))}
      </div>
      <p className="text-xs text-sh-gray">
        Tip: start with &quot;Sync Campaigns&quot; (fast). Then &quot;Sync Metrics&quot;. Activity
        is the slow one — can take several minutes the first time.
      </p>
    </div>
  );
}

function PhaseRow({
  phase,
  progress,
  isActive,
  disabled,
  onRun,
}: Readonly<{
  phase: Phase;
  progress: PhaseProgress | undefined;
  isActive: boolean;
  disabled: boolean;
  onRun: () => void;
}>) {
  return (
    <div className="border border-sh-gray/20 rounded-lg p-3 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-sh-black flex items-center gap-2">
          {PHASE_LABEL[phase]}
          {progress?.result && (
            <span className="text-xs text-green-700">✓ {fmtMs(progress.result.durationMs)}</span>
          )}
          {progress?.error && <span className="text-xs text-red-700">✗ {progress.error}</span>}
          {isActive && <span className="text-xs text-sh-blue">Running…</span>}
        </p>
        <p className="text-xs text-sh-gray mt-0.5">{PHASE_DESC[phase]}</p>
        {progress?.result && (
          <p className="text-xs text-sh-gray mt-1">{phaseProgressDetail(phase, progress.result)}</p>
        )}
      </div>
      <button
        type="button"
        onClick={onRun}
        disabled={disabled}
        className="text-xs px-3 py-2 rounded-lg border border-sh-blue text-sh-blue hover:bg-sh-blue hover:text-white transition disabled:opacity-50 shrink-0 min-h-[36px]"
      >
        Run
      </button>
    </div>
  );
}

// --- History table ----------------------------------------------------------

function HistoryTable({
  history,
  loading,
  total,
  page,
  totalPages,
  onPrev,
  onNext,
}: Readonly<{
  history: SyncLogRow[];
  loading: boolean;
  total: number;
  page: number;
  totalPages: number;
  onPrev: () => void;
  onNext: () => void;
}>) {
  return (
    <div className="bg-white border border-sh-gray/20 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-sh-gray/20 bg-sh-linen">
        <p className="text-sm text-sh-gray">
          Run history — {total.toLocaleString()} run{total === 1 ? "" : "s"}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onPrev}
            disabled={page === 1}
            className="px-2 py-1 text-sm text-sh-blue disabled:text-sh-gray/50"
          >
            ← Prev
          </button>
          <span className="text-sm text-sh-gray">
            Page {page} of {totalPages}
          </span>
          <button
            type="button"
            onClick={onNext}
            disabled={page >= totalPages}
            className="px-2 py-1 text-sm text-sh-blue disabled:text-sh-gray/50"
          >
            Next →
          </button>
        </div>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-sh-gray border-b border-sh-gray/20">
            <th className="px-3 py-2">When</th>
            <th className="px-3 py-2">Kind</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Duration</th>
            <th className="px-3 py-2">Summary</th>
          </tr>
        </thead>
        <tbody>
          {history.length === 0 && !loading ? (
            <tr>
              <td colSpan={5} className="px-3 py-6 text-center text-sh-gray">
                No runs yet.
              </td>
            </tr>
          ) : (
            history.map((r) => (
              <tr key={r.id} className="border-b border-sh-gray/10 hover:bg-sh-stripe">
                <td className="px-3 py-2 text-sh-black whitespace-nowrap">
                  {fmtDateTime(r.created)}
                </td>
                <td className="px-3 py-2 text-sh-gray">{r.kind}</td>
                <td className="px-3 py-2">
                  <span
                    className={`inline-block px-2 py-0.5 text-xs font-semibold rounded-full border ${STATUS_PILL[r.status] ?? ""}`}
                  >
                    {r.status}
                  </span>
                </td>
                <td className="px-3 py-2 text-sh-gray">{fmtDuration(r.startedAt, r.finishedAt)}</td>
                <td className="px-3 py-2 text-xs text-sh-gray">{historySummary(r)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

// --- Backfill / repair panel ------------------------------------------------
// Historical activity backfill + orphan customer-link repair. The daily sync
// only covers the trailing 14 days of campaigns, so anything older sits with
// no activity rows (and any activity whose Customer record came later sits
// unlinked). These two buttons clear both gaps. Uses fetch (not axios) to
// match the legacy chunk-loop behavior exactly.

interface ActivityChunkResponse {
  campaignsSynced: number;
  totalActivities: number;
  failed: unknown[];
  remaining: number;
  done: boolean;
  error?: string;
}

interface LinkBackfillResponse {
  rowsUpdated: number;
  orphansBefore: number;
  orphansAfter: number;
  error?: string;
}

function BackfillPanel() {
  const [running, setRunning] = useState<"activity" | "links" | null>(null);
  const [activityLog, setActivityLog] = useState<string[]>([]);
  const [activityDone, setActivityDone] = useState(false);
  const [linkResult, setLinkResult] = useState<string | null>(null);

  async function runActivityChunks() {
    setRunning("activity");
    setActivityLog([]);
    setActivityDone(false);
    try {
      for (let i = 0; i < 500; i++) {
        const res = await fetch("/api/mailchimp/sync-all-activity?maxCampaigns=40", {
          method: "POST",
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as ActivityChunkResponse;
          setActivityLog((prev) => [...prev, `Error: ${data.error || res.statusText}. Stopping.`]);
          break;
        }
        const data = (await res.json()) as ActivityChunkResponse;
        setActivityLog((prev) => [
          ...prev,
          `Chunk ${i + 1}: ${data.campaignsSynced} campaigns processed, ${data.totalActivities.toLocaleString()} activity rows inserted${data.failed.length ? `, ${data.failed.length} failed` : ""} — ${data.remaining} remaining`,
        ]);
        if (data.done) {
          setActivityDone(true);
          break;
        }
      }
    } finally {
      setRunning(null);
    }
  }

  async function runLinkBackfill() {
    setRunning("links");
    setLinkResult(null);
    try {
      const res = await fetch("/api/mailchimp/backfill-customer-links", { method: "POST" });
      const data = (await res.json()) as LinkBackfillResponse;
      if (!res.ok) {
        setLinkResult(`Error: ${data.error || res.statusText}`);
      } else {
        setLinkResult(
          `Linked ${data.rowsUpdated.toLocaleString()} activity rows to their Customer (${data.orphansBefore.toLocaleString()} orphans before, ${data.orphansAfter.toLocaleString()} still unlinked — those are Mailchimp subscribers we don't have as customers).`,
        );
      }
    } catch (err) {
      setLinkResult(`Request failed: ${getErrorMessage(err, "unknown error")}`);
    } finally {
      setRunning(null);
    }
  }

  return (
    <div className="bg-white border border-sh-gray/20 rounded-lg p-5 space-y-3">
      <h2 className="text-sm font-semibold text-sh-black">Backfill &amp; repair</h2>
      <p className="text-xs text-sh-gray">
        The daily cron only syncs the trailing 14 days of campaigns, so anything older has no
        activity rows. Use these two tools to reconcile history.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="border border-sh-gray/20 rounded-md p-3 space-y-2">
          <h3 className="text-sm font-semibold text-sh-navy">
            Backfill activity for old campaigns
          </h3>
          <p className="text-xs text-sh-gray">
            Hits the Mailchimp email-activity endpoint for every campaign that currently has zero
            activity rows. Chunks 40 campaigns per request to stay inside nginx&apos;s 300s limit;
            loops until done. Safe to run multiple times (upserts).
          </p>
          <Button
            onClick={runActivityChunks}
            disabled={running !== null}
            className="w-full min-h-[40px]"
          >
            {running === "activity" ? "Running…" : "Run activity backfill"}
          </Button>
          {activityLog.length > 0 && (
            <div className="bg-sh-linen/60 rounded-md p-2 text-[11px] font-mono max-h-48 overflow-y-auto">
              {activityLog.map((line) => (
                <div key={line} className="text-sh-black">
                  {line}
                </div>
              ))}
              {activityDone && (
                <div className="text-sh-navy font-semibold mt-1">Done — no campaigns remain.</div>
              )}
            </div>
          )}
        </div>

        <div className="border border-sh-gray/20 rounded-md p-3 space-y-2">
          <h3 className="text-sm font-semibold text-sh-navy">
            Relink orphan activity to customers
          </h3>
          <p className="text-xs text-sh-gray">
            Joins MailchimpActivity rows with no customerId back to Customer by email
            (case-insensitive). Useful when a customer&apos;s activity landed before their Customer
            record existed. Fast (single UPDATE). Safe to run repeatedly.
          </p>
          <Button
            onClick={runLinkBackfill}
            disabled={running !== null}
            className="w-full min-h-[40px]"
          >
            {running === "links" ? "Running…" : "Relink orphan activity"}
          </Button>
          {linkResult && (
            <p className="text-xs text-sh-black bg-sh-linen/60 rounded-md p-2">{linkResult}</p>
          )}
        </div>
      </div>
    </div>
  );
}

// --- New-customer audience sync panel --------------------------------------
// Pushes new ERP customers (created on/after the backfill cutoff) into the
// configured Mailchimp audience as PENDING (double opt-in). Idempotent.
// Mirrors POST /api/automations/mailchimp-customer-sync, which is also called
// by scripts/auto-mailchimp-customer-sync.sh on a daily cron.

interface CustomerSyncResult {
  scanned: number;
  pushed: number;
  skippedNoEmail: number;
  skippedInvalidEmail: number;
  errors: Array<{ customerId: number; email: string | null; message: string }>;
  dryRun: boolean;
}

function CustomerSyncPanel() {
  const [running, setRunning] = useState(false);
  const [lastResult, setLastResult] = useState<CustomerSyncResult | null>(null);

  async function runSync(dryRun: boolean) {
    setRunning(true);
    setLastResult(null);
    try {
      const res = await axios.post<CustomerSyncResult>(
        `/api/automations/mailchimp-customer-sync${dryRun ? "?dryRun=true" : ""}`,
        {},
        { timeout: 5 * 60 * 1000 },
      );
      setLastResult(res.data);
      const verb = dryRun ? "Dry run" : "Sync";
      if (res.data.errors.length > 0) {
        toast.warn(
          `${verb}: pushed ${res.data.pushed}, ${res.data.errors.length} error(s) — see details below.`,
        );
      } else {
        toast.success(`${verb}: ${res.data.pushed} contact(s) pushed to Mailchimp.`);
      }
    } catch (err) {
      toast.error(getErrorMessage(err, "Customer sync failed"));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="bg-white border border-sh-gray/20 rounded-lg p-5 space-y-3">
      <h2 className="text-sm font-semibold text-sh-black">New customer audience sync</h2>
      <p className="text-xs text-sh-gray">
        Pushes ERP customers (with a valid email, created on or after the backfill cutoff date, not
        yet synced) into your Mailchimp audience as <strong>pending</strong> — Mailchimp sends them
        a double opt-in confirmation. Idempotent: existing subscribed members keep their status;
        only new contacts get the confirmation. Daily cron runs at most 200 contacts per tick.
      </p>
      <div className="flex flex-wrap gap-3">
        <Button onClick={() => runSync(false)} disabled={running} className="min-h-[40px] px-4">
          {running ? "Running…" : "Push new customers"}
        </Button>
        <button
          type="button"
          onClick={() => runSync(true)}
          disabled={running}
          className="text-xs px-3 py-2 rounded-lg border border-sh-blue text-sh-blue hover:bg-sh-blue hover:text-white transition disabled:opacity-50 min-h-[40px]"
        >
          {running ? "…" : "Dry run"}
        </button>
      </div>
      {lastResult && (
        <div className="text-xs text-sh-black bg-sh-linen/60 rounded-md p-3 space-y-1">
          <p>
            <strong>Last result</strong>
            {lastResult.dryRun ? " (dry run)" : ""}: scanned {lastResult.scanned.toLocaleString()},
            pushed {lastResult.pushed.toLocaleString()}, skipped no-email{" "}
            {lastResult.skippedNoEmail.toLocaleString()}, skipped invalid email{" "}
            {lastResult.skippedInvalidEmail.toLocaleString()}, errors{" "}
            {lastResult.errors.length.toLocaleString()}.
          </p>
          {lastResult.errors.length > 0 && (
            <ul className="list-disc pl-4 space-y-0.5 text-sh-gray">
              {lastResult.errors.slice(0, 10).map((e) => (
                <li key={e.customerId}>
                  <span className="font-mono">#{e.customerId}</span> {e.email ?? "—"}: {e.message}
                </li>
              ))}
              {lastResult.errors.length > 10 && (
                <li>…and {lastResult.errors.length - 10} more (see server logs).</li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
