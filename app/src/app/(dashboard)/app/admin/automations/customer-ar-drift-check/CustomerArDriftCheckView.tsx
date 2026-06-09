// /app/src/app/(dashboard)/app/admin/automations/customer-ar-drift-check/CustomerArDriftCheckView.tsx
//
// Client view for the AR-drift report. Compares stored Customer.openArBalance
// against the live source-of-truth recompute (line items minus payments). A
// "Run check" button POSTs to /api/automations/customer-ar-drift-check and
// renders the response inline. No persistence — the cron's stdout log on the
// NAS is the historical record.

"use client";

import { useState } from "react";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { toast } from "react-toastify";
import { getErrorMessage } from "@/lib/toastError";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";

interface DriftRow {
  customerId: number;
  label: string;
  storedBalance: number;
  sourceBalance: number;
  diff: number;
  message: string;
}

type DriftMode = "lookback" | "hand-picked";

interface DriftResponse {
  runAt: string;
  mode: DriftMode;
  lookbackHours: number | null;
  checked: number;
  ok: number;
  drifted: DriftRow[];
  totalAbsoluteDrift: number;
}

type MoneyFormatter = (value: number | null | undefined) => string;

const LOOKBACK_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 26, label: "Last 26 hours (default — daily cron window)" },
  { value: 24 * 7, label: "Last 7 days" },
  { value: 24 * 30, label: "Last 30 days" },
];

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

/** Pure helper — split a textarea of customer IDs (one per line or
 *  comma-separated) into a deduped list of valid positive ints. */
function parseCustomerIds(raw: string): number[] {
  const tokens = raw.split(/[\s,]+/).filter((t) => t.length > 0);
  const ids = tokens.map((t) => Number.parseInt(t, 10)).filter((n) => Number.isInteger(n) && n > 0);
  return Array.from(new Set(ids));
}

export function CustomerArDriftCheckView() {
  const formatMoney = useMoneyFormatter();
  const [report, setReport] = useState<DriftResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [mode, setMode] = useState<DriftMode>("lookback");
  const [lookbackHours, setLookbackHours] = useState<number>(26);
  // Hand-pick mode. Stored as raw string so the admin can edit freely; parsed
  // on submit. Examples accepted: "1,2,3", "1 2 3", one per line, mixed.
  const [customerIdsRaw, setCustomerIdsRaw] = useState<string>("");

  const parsedCustomerIds = mode === "hand-picked" ? parseCustomerIds(customerIdsRaw) : [];
  const canRun =
    !running && (mode === "lookback" || (mode === "hand-picked" && parsedCustomerIds.length > 0));

  async function runCheck(): Promise<void> {
    setRunning(true);
    try {
      const params: Record<string, string | number> = {};
      if (mode === "hand-picked") {
        params.customerIds = parsedCustomerIds.join(",");
      } else {
        params.lookbackHours = lookbackHours;
      }
      const res = await axios.post<DriftResponse>(
        "/api/automations/customer-ar-drift-check",
        null,
        { params },
      );
      setReport(res.data);
      if (res.data.drifted.length === 0) {
        toast.success(`AR drift check passed — ${res.data.checked} customers OK`);
      } else {
        toast.warn(
          `AR drift detected on ${res.data.drifted.length} of ${res.data.checked} customers`,
        );
      }
    } catch (err) {
      toast.error(getErrorMessage(err, "AR drift check failed"));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="max-w-screen-lg mx-auto py-6 space-y-4">
      <header>
        <h1 className="font-serif text-3xl text-sh-navy">Customer AR Drift Check</h1>
        <p className="text-sm text-sh-gray mt-1">
          Compares stored <code>Customer.openArBalance</code> against the live source-of-truth
          recompute (line items minus payments, per CLAUDE.md rule 33). Runs daily via Synology Task
          Scheduler at 04:30; use the button below to run it on-demand.
        </p>
      </header>

      <section className="bg-white border border-sh-stripe rounded-lg p-4 space-y-3">
        {/* Mode toggle. Lookback for daily-cron-style activity sweeps;
            hand-picked for the cutover validation pass (admin pastes the
            customer IDs they want to verify). */}
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Selection mode">
          <button
            type="button"
            role="radio"
            aria-checked={mode === "lookback"}
            onClick={() => setMode("lookback")}
            disabled={running}
            className={`px-4 py-2 rounded border text-sm font-semibold min-h-[44px] ${
              mode === "lookback"
                ? "bg-sh-navy text-white border-sh-navy"
                : "bg-white text-sh-navy border-sh-stripe hover:bg-sh-stripe"
            }`}
          >
            By recent activity
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === "hand-picked"}
            onClick={() => setMode("hand-picked")}
            disabled={running}
            className={`px-4 py-2 rounded border text-sm font-semibold min-h-[44px] ${
              mode === "hand-picked"
                ? "bg-sh-navy text-white border-sh-navy"
                : "bg-white text-sh-navy border-sh-stripe hover:bg-sh-stripe"
            }`}
          >
            Specific customer IDs
          </button>
        </div>

        {mode === "lookback" && (
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label
                htmlFor="lookback-hours"
                className="block text-sm font-semibold text-sh-navy mb-1"
              >
                Lookback window
              </label>
              <select
                id="lookback-hours"
                value={lookbackHours}
                onChange={(e) => setLookbackHours(Number.parseInt(e.target.value, 10))}
                disabled={running}
                className="px-3 py-2 border border-sh-stripe rounded text-base min-h-[44px]"
              >
                {LOOKBACK_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <Button onClick={runCheck} disabled={!canRun} className="min-h-[44px]">
              {running ? "Running…" : "Run check"}
            </Button>
            {report && (
              <div className="ml-auto text-xs text-sh-gray text-right">
                Last run: {fmtDateTime(report.runAt)}
                <br />
                Mode: {report.mode}
                {report.lookbackHours === null ? "" : ` · Lookback ${report.lookbackHours}h`}
              </div>
            )}
          </div>
        )}

        {mode === "hand-picked" && (
          <div className="space-y-2">
            <label
              htmlFor="customer-ids-input"
              className="block text-sm font-semibold text-sh-navy"
            >
              Customer IDs to validate
            </label>
            <textarea
              id="customer-ids-input"
              value={customerIdsRaw}
              onChange={(e) => setCustomerIdsRaw(e.target.value)}
              disabled={running}
              rows={4}
              placeholder="One per line, or comma-separated. e.g. 1234, 5678, 9012"
              className="w-full px-3 py-2 border border-sh-stripe rounded text-base font-mono"
            />
            <div className="flex flex-wrap items-center gap-3 text-xs text-sh-gray">
              <span>{parsedCustomerIds.length} valid IDs parsed</span>
              {parsedCustomerIds.length > 0 && parsedCustomerIds.length <= 20 && (
                <span className="text-sh-navy">[{parsedCustomerIds.join(", ")}]</span>
              )}
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <Button onClick={runCheck} disabled={!canRun} className="min-h-[44px]">
                {running ? "Running…" : "Validate these customers"}
              </Button>
              {report && (
                <div className="ml-auto text-xs text-sh-gray text-right">
                  Last run: {fmtDateTime(report.runAt)}
                  <br />
                  Mode: {report.mode}
                </div>
              )}
            </div>
            <p className="text-xs text-sh-gray">
              Use this mode to cross-check specific customers during the AR ledger cutover — pick a
              mix of long-time regulars, customers with deposits, customers with refund chains, and
              gift-card buyers, then compare the report against the POS&apos;s balance for each.
            </p>
          </div>
        )}
      </section>

      {report && <ReportPanel report={report} formatMoney={formatMoney} />}

      {!report && (
        <div className="bg-sh-stripe/30 border border-sh-stripe rounded-lg p-6 text-sm text-sh-gray text-center">
          Click <strong>Run check</strong> to scan customers with recent activity. The default
          26-hour window mirrors the nightly cron — widen the window to investigate older drift.
        </div>
      )}

      <footer className="text-xs text-sh-gray space-y-1 mt-6">
        <p>
          <strong>Drift direction</strong>: <code>diff</code> is signed.{" "}
          <span className="text-red-700">Negative</span> means stored is BELOW source (under-billed
          — we believe they owe less than the source rows say). Positive means stored is ABOVE
          source.
        </p>
        <p>
          <strong>Common causes</strong>: code path bypassed <code>appendEntry</code>; payment
          VOIDED after its ledger entry was written; manual SQL UPDATE on the source side. See{" "}
          <code>docs/OPERATIONS.md &gt; Customer AR Drift Check</code> for triage steps.
        </p>
      </footer>
    </div>
  );
}

function ReportPanel({
  report,
  formatMoney,
}: Readonly<{ report: DriftResponse; formatMoney: MoneyFormatter }>) {
  const allOk = report.drifted.length === 0;
  return (
    <section
      className={`border rounded-lg p-4 ${
        allOk ? "bg-green-50 border-green-200" : "bg-red-50 border-red-200"
      }`}
    >
      <div className="flex flex-wrap gap-4 mb-3">
        <Kpi label="Checked" value={String(report.checked)} />
        <Kpi label="OK" value={String(report.ok)} accent={allOk ? "green" : undefined} />
        <Kpi
          label="Drifted"
          value={String(report.drifted.length)}
          accent={allOk ? undefined : "red"}
        />
        <Kpi label="Total |drift|" value={formatMoney(report.totalAbsoluteDrift)} />
      </div>

      {allOk ? (
        <p className="text-sm text-green-800">
          All checked customers are in sync within $0.005. No action needed.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-sh-gray tracking-wide border-b border-sh-stripe">
                <th className="py-2 pr-3">Customer</th>
                <th className="py-2 pr-3 text-right">Stored</th>
                <th className="py-2 pr-3 text-right">Source</th>
                <th className="py-2 pr-3 text-right">Diff</th>
                <th className="py-2 pr-3">Notes</th>
              </tr>
            </thead>
            <tbody>
              {report.drifted.map((d) => (
                <tr key={d.customerId} className="border-b border-sh-stripe last:border-0">
                  <td className="py-2 pr-3">
                    <a
                      href={`/customers/${d.customerId}`}
                      className="text-sh-navy hover:underline font-semibold"
                    >
                      {d.label}
                    </a>
                    <div className="text-xs text-sh-gray">#{d.customerId}</div>
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {formatMoney(d.storedBalance)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {formatMoney(d.sourceBalance)}
                  </td>
                  <td
                    className={`py-2 pr-3 text-right tabular-nums font-semibold ${
                      d.diff < 0 ? "text-red-700" : "text-amber-700"
                    }`}
                  >
                    {formatMoney(d.diff)}
                  </td>
                  <td className="py-2 pr-3 text-xs text-sh-gray">{d.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const KPI_ACCENT_CLASS: Record<"green" | "red" | "default", string> = {
  green: "text-green-700",
  red: "text-red-700",
  default: "text-sh-navy",
};

function Kpi({
  label,
  value,
  accent,
}: Readonly<{ label: string; value: string; accent?: "green" | "red" }>) {
  const valueClass = KPI_ACCENT_CLASS[accent ?? "default"];
  return (
    <div>
      <div className="text-xs uppercase text-sh-gray tracking-wide">{label}</div>
      <div className={`text-2xl font-serif ${valueClass}`}>{value}</div>
    </div>
  );
}
