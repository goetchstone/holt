"use client";

// /app/src/app/(dashboard)/app/admin/tools/customer-ledger-backfill/CustomerLedgerBackfillView.tsx
//
// Phase 0.5.3 -- admin UI to trigger the one-time customer ledger backfill.
//
// Strategy: fetch the full Customer id list via the cheap /customer-ids
// endpoint, then POST /backfill?customerIds=… in batches of 200. Each batch
// fits comfortably inside the nginx 300s proxy timeout (single runs of all
// ~14K customers in prod blew past the limit and surfaced as a 504 in the
// browser). Results are aggregated client-side and shown when the run finishes.
//
// Idempotent -- already-backfilled customers are skipped on the server side, so
// a partial run can be resumed by re-clicking. Reads the shared
// /api/admin/customer-ledger/* REST endpoints. Chrome from the (dashboard)
// layout.

import { useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { Loader2, Database } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";

const BATCH_SIZE = 200;

interface DriftedCustomer {
  customerId: number;
  ledgerBalance: number;
  sourceBalance: number;
  diff: number;
}

interface BackfillResponse {
  customersTotal: number;
  customersBackfilled: number;
  customersBackfilledWithDrift: number;
  customersSkipped: number;
  customersFailed: number;
  entriesCreated: number;
  totalDriftDollars: number;
  driftedCustomers: DriftedCustomer[];
  errors: Array<{ customerId: number; message: string }>;
}

interface ProgressState {
  totalCustomers: number;
  processed: number;
  batchesDone: number;
  batchesTotal: number;
  currentError: string | null;
}

const EMPTY_AGGREGATE: BackfillResponse = {
  customersTotal: 0,
  customersBackfilled: 0,
  customersBackfilledWithDrift: 0,
  customersSkipped: 0,
  customersFailed: 0,
  entriesCreated: 0,
  totalDriftDollars: 0,
  driftedCustomers: [],
  errors: [],
};

function mergeResult(acc: BackfillResponse, batch: BackfillResponse): BackfillResponse {
  return {
    customersTotal: acc.customersTotal + batch.customersTotal,
    customersBackfilled: acc.customersBackfilled + batch.customersBackfilled,
    customersBackfilledWithDrift:
      acc.customersBackfilledWithDrift + batch.customersBackfilledWithDrift,
    customersSkipped: acc.customersSkipped + batch.customersSkipped,
    customersFailed: acc.customersFailed + batch.customersFailed,
    entriesCreated: acc.entriesCreated + batch.entriesCreated,
    totalDriftDollars: Math.round((acc.totalDriftDollars + batch.totalDriftDollars) * 100) / 100,
    driftedCustomers: [...acc.driftedCustomers, ...batch.driftedCustomers],
    errors: [...acc.errors, ...batch.errors],
  };
}

function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function progressPercent(progress: ProgressState): number {
  if (progress.batchesTotal <= 0) return 0;
  return Math.round((progress.batchesDone / progress.batchesTotal) * 100);
}

function ProgressBar({ progress }: Readonly<{ progress: ProgressState }>) {
  return (
    <div className="text-sm text-sh-gray space-y-1">
      <div className="flex justify-between font-mono">
        <span>
          Batch {progress.batchesDone} / {progress.batchesTotal}
        </span>
        <span>
          {progress.processed} / {progress.totalCustomers} customers
        </span>
      </div>
      <div className="h-2 w-full bg-sh-stripe rounded overflow-hidden">
        <div
          className="h-full bg-sh-gold transition-all"
          style={{ width: `${progressPercent(progress)}%` }}
        />
      </div>
      {progress.currentError && <p className="text-xs text-red-700">{progress.currentError}</p>}
    </div>
  );
}

type MoneyFmt = ReturnType<typeof useMoneyFormatter>;

function BackfillSummary({ result, fmt }: Readonly<{ result: BackfillResponse; fmt: MoneyFmt }>) {
  return (
    <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
      <dt className="text-sh-gray">Total customers</dt>
      <dd className="font-mono text-sh-navy">{result.customersTotal}</dd>
      <dt className="text-sh-gray">Backfilled cleanly</dt>
      <dd className="font-mono text-sh-navy">{result.customersBackfilled}</dd>
      <dt className="text-sh-gray">Backfilled with drift</dt>
      <dd className="font-mono text-sh-navy">{result.customersBackfilledWithDrift}</dd>
      <dt className="text-sh-gray">Skipped (already done or no orders)</dt>
      <dd className="font-mono text-sh-navy">{result.customersSkipped}</dd>
      <dt className="text-sh-gray">Failed</dt>
      <dd className="font-mono text-sh-navy">{result.customersFailed}</dd>
      <dt className="text-sh-gray">Entries created</dt>
      <dd className="font-mono text-sh-navy">{result.entriesCreated}</dd>
      <dt className="text-sh-gray">Total drift</dt>
      <dd className="font-mono text-sh-navy">{fmt(result.totalDriftDollars)}</dd>
    </dl>
  );
}

function DriftedCustomersTable({
  drifted,
  fmt,
}: Readonly<{ drifted: DriftedCustomer[]; fmt: MoneyFmt }>) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-sh-navy mb-2">Drifted customers (review needed)</h3>
      <div className="overflow-x-auto rounded border border-gray-200">
        <table className="w-full text-sm">
          <thead className="bg-sh-linen">
            <tr>
              <th className="px-3 py-2 text-left text-xs font-medium text-sh-gray">Customer ID</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-sh-gray">Ledger</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-sh-gray">
                Source (computeBalance)
              </th>
              <th className="px-3 py-2 text-right text-xs font-medium text-sh-gray">Diff</th>
            </tr>
          </thead>
          <tbody>
            {drifted.slice(0, 100).map((d) => (
              <tr key={d.customerId} className="border-t border-gray-100">
                <td className="px-3 py-2 font-mono">
                  <a
                    href={`/app/sales/customers/${d.customerId}`}
                    className="text-sh-blue hover:underline"
                  >
                    {d.customerId}
                  </a>
                </td>
                <td className="px-3 py-2 font-mono text-right">{fmt(d.ledgerBalance)}</td>
                <td className="px-3 py-2 font-mono text-right">{fmt(d.sourceBalance)}</td>
                <td className="px-3 py-2 font-mono text-right">{fmt(d.diff)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {drifted.length > 100 && (
          <p className="px-3 py-2 text-xs text-sh-gray bg-sh-linen">
            Showing first 100 of {drifted.length}. Full list in the response payload.
          </p>
        )}
      </div>
    </div>
  );
}

function BackfillErrors({
  errors,
}: Readonly<{ errors: Array<{ customerId: number; message: string }> }>) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-sh-navy mb-2">Errors</h3>
      <ul className="text-xs text-red-700 list-disc pl-5 space-y-1">
        {errors.slice(0, 50).map((e) => (
          <li key={e.customerId} className="font-mono">
            Customer {e.customerId}: {e.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CustomerLedgerBackfillView() {
  const fmt = useMoneyFormatter();
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [result, setResult] = useState<BackfillResponse | null>(null);

  const handleRun = async () => {
    if (
      !globalThis.confirm(
        "Run the customer-ledger backfill against ALL customers? Walks every customer's order/payment history in batches of " +
          BATCH_SIZE +
          " — idempotent, safe to re-run.",
      )
    ) {
      return;
    }
    setRunning(true);
    setResult(null);
    setProgress(null);

    try {
      // Step 1: cheap query for the full id list.
      const listRes = await axios.get<{ ids: number[]; total: number }>(
        "/api/admin/customer-ledger/customer-ids",
      );
      const ids = listRes.data.ids ?? [];
      if (ids.length === 0) {
        toast.info("No customers found.");
        setRunning(false);
        return;
      }

      const batches = chunk(ids, BATCH_SIZE);
      setProgress({
        totalCustomers: ids.length,
        processed: 0,
        batchesDone: 0,
        batchesTotal: batches.length,
        currentError: null,
      });

      // Step 2: POST each batch sequentially. Sequential (not parallel) so the
      // server isn't drowned and Postgres lock contention on Customer rows stays
      // bounded.
      let aggregate: BackfillResponse = EMPTY_AGGREGATE;
      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        try {
          const res = await axios.post<BackfillResponse>("/api/admin/customer-ledger/backfill", {
            customerIds: batch,
          });
          aggregate = mergeResult(aggregate, res.data);
        } catch (err: unknown) {
          // One failed batch shouldn't kill the run. Record + continue.
          const msg = getErrorMessage(err, `Batch ${i + 1} failed`);
          aggregate = {
            ...aggregate,
            customersFailed: aggregate.customersFailed + batch.length,
            errors: [...aggregate.errors, ...batch.map((id) => ({ customerId: id, message: msg }))],
          };
          setProgress((p) =>
            p ? { ...p, currentError: `Batch ${i + 1}/${batches.length}: ${msg}` } : p,
          );
        }
        setProgress((p) =>
          p ? { ...p, processed: aggregate.customersTotal, batchesDone: i + 1 } : p,
        );
        setResult(aggregate); // live-update so the user sees rows as they arrive
      }

      toast.success(
        `Done. ${aggregate.customersBackfilled} backfilled · ${aggregate.customersBackfilledWithDrift} with drift · ${aggregate.customersSkipped} skipped · ${aggregate.customersFailed} failed`,
      );
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Backfill failed"));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-6 py-2">
      <div>
        <h1 className="text-2xl font-serif text-sh-navy">Customer Ledger Backfill</h1>
        <p className="text-sm text-sh-gray mt-2 max-w-2xl">
          Walks every customer&apos;s historical orders + payments and writes ledger entries to{" "}
          <code className="px-1">CustomerLedgerEntry</code>. Updates{" "}
          <code className="px-1">Customer.openArBalance</code> with the running total. Idempotent —
          already-backfilled customers are skipped on re-run.
        </p>
        <p className="text-sm text-sh-gray mt-2 max-w-2xl">
          This is a one-time Phase 0.5.3 migration step. Once the backfill has run cleanly across
          all customers, the daily-recon cron (Phase 0.5.5) takes over to keep the ledger in sync
          going forward.
        </p>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-5 space-y-4">
        <Button
          onClick={handleRun}
          disabled={running}
          className="min-h-[44px] inline-flex items-center gap-2"
        >
          {running ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Running backfill...
            </>
          ) : (
            <>
              <Database className="h-4 w-4" />
              Run backfill
            </>
          )}
        </Button>

        {progress && <ProgressBar progress={progress} />}
      </div>

      {result && (
        <div className="rounded-lg border border-gray-200 bg-white p-5 space-y-4">
          <h2 className="text-lg font-serif text-sh-navy">Results</h2>
          <BackfillSummary result={result} fmt={fmt} />
          {result.driftedCustomers.length > 0 && (
            <DriftedCustomersTable drifted={result.driftedCustomers} fmt={fmt} />
          )}
          {result.errors.length > 0 && <BackfillErrors errors={result.errors} />}
        </div>
      )}
    </div>
  );
}
