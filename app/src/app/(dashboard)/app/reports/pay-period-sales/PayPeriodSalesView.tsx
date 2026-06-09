"use client";

// /app/src/app/(dashboard)/app/reports/pay-period-sales/PayPeriodSalesView.tsx
//
// Pay-period sales statement + manager confirmation grid. SUPER_ADMIN-only
// (tabled per owner direction 2026-05-29). Statement + grid read via tRPC; the
// confirm / report-issue / reopen / resolve-issue actions stay REST POSTs to
// their existing endpoints, and the designer picker reads /api/staff over REST.
// After any mutation succeeds, the relevant tRPC query is refetched.
//
// This is the SUPER_ADMIN surface, so the privileged path is always taken — the
// designer picker is the only way in, and mutations always carry staffMemberId.

import { useCallback, useEffect, useMemo, useState } from "react";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { KpiCard } from "@/components/report/KpiCard";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "react-toastify";
import { getErrorMessage } from "@/lib/toastError";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { api } from "@/lib/trpc/client";

const PERIOD_DAYS = 14;

interface StaffOption {
  id: number;
  displayName: string;
}
interface OpenIssue {
  id: number;
  note: string;
  reportedBy: string;
  reportedAt: string | Date;
}
interface ConfirmStatusRow {
  staffMemberId: number;
  displayName: string;
  confirmationId: number | null;
  confirmedAt: string | Date | null;
  reopenedAt: string | Date | null;
  isLocked: boolean;
  openIssue: OpenIssue | null;
}

/** Shift a YYYY-MM-DD by ±N days in UTC, returns YYYY-MM-DD. */
function shiftYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Confirmation-status cell for the manager grid (avoids a nested ternary in JSX). */
function renderConfirmStatus(r: ConfirmStatusRow) {
  // An open issue is the actionable signal — show it first.
  if (r.openIssue) {
    return (
      <span className="text-red-700">
        <span>⚠ issue reported</span>
        <span className="ml-1 block text-xs text-sh-gray">“{r.openIssue.note}”</span>
      </span>
    );
  }
  if (r.isLocked) {
    const when = r.confirmedAt
      ? ` ${new Date(r.confirmedAt).toLocaleDateString("en-US", { timeZone: "America/New_York" })}`
      : "";
    return <span className="text-green-700">✓ confirmed{when}</span>;
  }
  if (r.reopenedAt) {
    return <span className="text-amber-700">reopened</span>;
  }
  return <span className="text-sh-gray">not confirmed</span>;
}

export function PayPeriodSalesView() {
  const money = useMoneyFormatter();
  const currency = (v: number) => money(v, { whole: true });

  // SUPER_ADMIN-only surface — the privileged path is always taken.
  const isPrivileged = true;

  // periodStart drives the query; null means "current period" (the API defaults
  // to the period containing today).
  const [periodStart, setPeriodStart] = useState<string | null>(null);
  const [staffMemberId, setStaffMemberId] = useState<number | null>(null);
  const [staffOptions, setStaffOptions] = useState<StaffOption[]>([]);

  // Privileged: load the designer dropdown once (REST — /api/staff kept).
  useEffect(() => {
    axios
      .get<{ staff: StaffOption[] } | StaffOption[]>("/api/staff?isDesigner=true")
      .then(({ data: d }) => {
        const list = Array.isArray(d) ? d : d.staff;
        setStaffOptions(list ?? []);
      })
      .catch(() => setStaffOptions([]));
  }, []);

  // Per-designer statement via tRPC. periodStart null = current period.
  const statementQuery = api.reports.payPeriodSales.useQuery({
    periodStart: periodStart ?? undefined,
    staffMemberId: staffMemberId ?? undefined,
  });
  const data = statementQuery.data ?? null;
  const loading = statementQuery.isFetching;

  // Manager confirmation-status grid for the period (privileged only). The query
  // is enabled once we have a resolved period start.
  const gridPeriodStart = data?.period.start ?? periodStart ?? undefined;
  const gridQuery = api.reports.payPeriodConfirmations.useQuery(
    { periodStart: gridPeriodStart },
    { enabled: Boolean(gridPeriodStart) },
  );
  const statusRows = gridQuery.data?.rows ?? [];
  const readyForReview = gridQuery.data?.readyForReview ?? false;

  const [confirming, setConfirming] = useState(false);
  const [reporting, setReporting] = useState(false);

  const refetchBoth = useCallback(async () => {
    await statementQuery.refetch();
    await gridQuery.refetch();
  }, [statementQuery, gridQuery]);

  function gotoPeriod(deltaDays: number) {
    const base = data?.period.start ?? periodStart;
    if (!base) return;
    setPeriodStart(shiftYmd(base, deltaDays));
  }

  async function handleConfirm() {
    if (!data?.designer) return;
    setConfirming(true);
    try {
      await axios.post("/api/reports/pay-period-sales/confirm", {
        periodStart: data.period.start,
        ...(isPrivileged ? { staffMemberId: data.designer.id } : {}),
      });
      toast.success("Numbers confirmed for the period.");
      await refetchBoth();
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to confirm"));
    } finally {
      setConfirming(false);
    }
  }

  async function handleReopen(confirmationId: number) {
    const reason = globalThis.prompt("Reason for reopening this confirmed period? (required)");
    if (!reason?.trim()) return;
    try {
      await axios.post("/api/admin/reports/pay-period-confirmations/reopen", {
        confirmationId,
        reason: reason.trim(),
      });
      toast.success("Period reopened.");
      await refetchBoth();
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to reopen"));
    }
  }

  async function handleReportIssue() {
    if (!data?.designer) return;
    const note = globalThis.prompt(
      "What looks wrong with these numbers? This flags the period for your manager (it won't confirm/lock it).",
    );
    if (!note?.trim()) return;
    setReporting(true);
    try {
      await axios.post("/api/reports/pay-period-sales/report-issue", {
        periodStart: data.period.start,
        note: note.trim(),
        ...(isPrivileged ? { staffMemberId: data.designer.id } : {}),
      });
      toast.success("Issue reported. Your manager will review before the period is confirmed.");
      await refetchBoth();
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to report issue"));
    } finally {
      setReporting(false);
    }
  }

  async function handleResolveIssue(issueId: number) {
    const resolutionNote = globalThis.prompt("Resolution note (optional) — what was fixed?") ?? "";
    try {
      await axios.post("/api/admin/reports/pay-period-confirmations/resolve-issue", {
        issueId,
        resolutionNote: resolutionNote.trim(),
      });
      toast.success("Issue resolved.");
      await refetchBoth();
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to resolve issue"));
    }
  }

  function handleExport() {
    if (!data?.orders.length) return;
    const header = ["Order #", "Date", "Customer", "Store", "Split", "Credited Net"];
    const rows = data.orders.map((o) => [
      o.orderNumber,
      o.orderDate,
      o.customer,
      o.storeLocation ?? "",
      o.isSplit ? "50%" : "",
      o.creditedNet.toFixed(2),
    ]);
    const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
    const lines = [
      header,
      ...rows,
      [],
      ["Period total", "", "", "", "", data.periodTotal.toFixed(2)],
      ["YTD total", "", "", "", "", data.ytdTotal.toFixed(2)],
    ]
      .map((r) => r.map((c) => csvCell(String(c))).join(","))
      .join("\n");
    const blob = new Blob([lines], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const who = data.designer?.displayName.replaceAll(/\s+/g, "-") ?? "designer";
    a.download = `pay-period-${who}-${data.period.start}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const totalCredited = useMemo(
    () => data?.orders.reduce((s, o) => s + o.creditedNet, 0) ?? 0,
    [data],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-sh-navy font-serif">Pay Period Sales</h1>
          <p className="mt-1 text-sm text-sh-gray">
            Your sales for the bi-weekly pay period — order detail, period total, and year-to-date.
            Split orders are credited at 50%. This is sales only; commission is calculated
            separately by management.
          </p>
        </div>
        <Button onClick={handleExport} variant="outline" disabled={loading || !data?.orders.length}>
          Export CSV
        </Button>
      </div>

      {/* Period nav + designer picker */}
      <section className="rounded border border-sh-stripe bg-white p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => gotoPeriod(-PERIOD_DAYS)} disabled={loading}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="min-w-[180px] text-center text-sm font-medium text-sh-navy">
              {data?.period.label ?? "…"}
            </span>
            <Button variant="outline" onClick={() => gotoPeriod(PERIOD_DAYS)} disabled={loading}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>

          {isPrivileged && (
            <div>
              <label htmlFor="designer" className="sr-only">
                Designer
              </label>
              <select
                id="designer"
                value={staffMemberId ?? ""}
                onChange={(e) => setStaffMemberId(e.target.value ? Number(e.target.value) : null)}
                className="rounded border border-gray-300 px-3 py-2 text-sm min-h-[44px]"
              >
                <option value="">Select a designer…</option>
                {staffOptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.displayName}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      </section>

      {/* Privileged-with-no-pick prompt */}
      {data?.needsSelection && (
        <p className="text-sm text-sh-gray">
          Pick a designer above to view their pay-period statement.
        </p>
      )}

      {/* KPI cards */}
      {data?.designer && (
        <section className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <KpiCard
            label="Period Sales"
            value={currency(data.periodTotal)}
            sub={data.period.label}
          />
          <KpiCard
            label="YTD Sales"
            value={currency(data.ytdTotal)}
            sub={`Through ${data.period.end}`}
          />
          <KpiCard label="Orders" value={data.orders.length} sub={data.designer.displayName} />
        </section>
      )}

      {/* Confirm banner */}
      {data?.designer && data.confirmation && (
        <section className="rounded border border-sh-stripe bg-white p-4">
          {data.confirmation.confirmed && (
            <p className="text-sm text-green-700">
              ✓ Confirmed
              {data.confirmation.confirmedAt
                ? ` on ${new Date(data.confirmation.confirmedAt).toLocaleDateString("en-US", { timeZone: "America/New_York" })}`
                : ""}
              . Attribution for this period is locked. A manager must reopen it to make changes.
            </p>
          )}
          {!data.confirmation.confirmed && data.issue?.open && (
            <p className="text-sm text-red-700">
              <span>
                ⚠ You reported an issue for this period — your manager will review it before it can
                be confirmed.
              </span>
              {data.issue.note ? (
                <span className="mt-1 block text-xs text-sh-gray">“{data.issue.note}”</span>
              ) : null}
            </p>
          )}
          {!data.confirmation.confirmed && !data.issue?.open && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-sh-gray">
                {data.confirmation.confirmable
                  ? "Review the orders below. When they look right, confirm to lock the period. If something's wrong, report an issue instead."
                  : "You can confirm these numbers once the pay period has ended. If something looks wrong now, report an issue."}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  onClick={handleReportIssue}
                  disabled={reporting || loading}
                >
                  {reporting ? "Reporting…" : "Report an issue"}
                </Button>
                <Button
                  onClick={handleConfirm}
                  disabled={!data.confirmation.confirmable || confirming || loading}
                >
                  {confirming ? "Confirming…" : "Confirm these numbers"}
                </Button>
              </div>
            </div>
          )}
        </section>
      )}

      {/* Manager confirmation-status grid */}
      {isPrivileged && statusRows.length > 0 && (
        <section className="rounded border border-sh-stripe bg-white p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-sh-navy">
              Confirmation status — {data?.period.label}
            </h2>
            {readyForReview ? (
              <span className="text-xs font-medium text-green-700">
                ✓ Ready for review — all designers confirmed
              </span>
            ) : (
              <span className="text-xs text-sh-gray">Waiting on confirmations</span>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-xs">
              <tbody>
                {statusRows.map((r) => (
                  <tr key={r.staffMemberId} className="border-t border-sh-stripe">
                    <td className="p-2">{r.displayName}</td>
                    <td className="p-2">{renderConfirmStatus(r)}</td>
                    <td className="p-2 text-right">
                      <div className="flex items-center justify-end gap-3">
                        {r.openIssue && (
                          <button
                            type="button"
                            onClick={() => handleResolveIssue(r.openIssue!.id)}
                            className="text-green-700 hover:underline"
                          >
                            Resolve issue
                          </button>
                        )}
                        {r.isLocked && r.confirmationId !== null && (
                          <button
                            type="button"
                            onClick={() => handleReopen(r.confirmationId!)}
                            className="text-sh-gold hover:underline"
                          >
                            Reopen
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Detail table */}
      {data?.designer && (
        <section>
          {loading && <p className="text-sm text-sh-gray">Loading…</p>}
          {!loading && data.orders.length === 0 && (
            <p className="text-sm text-sh-gray py-6 text-center">No sales in this pay period.</p>
          )}
          {!loading && data.orders.length > 0 && (
            <div className="overflow-x-auto rounded border border-sh-stripe bg-white">
              <table className="min-w-full text-left text-sm">
                <thead className="bg-sh-linen text-sh-black">
                  <tr>
                    <th className="p-2 font-medium">Order #</th>
                    <th className="p-2 font-medium">Date</th>
                    <th className="p-2 font-medium">Customer</th>
                    <th className="p-2 font-medium">Store</th>
                    <th className="p-2 font-medium text-right">Credited Net</th>
                  </tr>
                </thead>
                <tbody>
                  {data.orders.map((o, i) => (
                    <tr
                      key={o.orderId}
                      className={`border-t border-sh-stripe ${i % 2 === 1 ? "bg-sh-stripe/40" : ""}`}
                    >
                      <td className="p-2 font-mono text-xs">{o.orderNumber}</td>
                      <td className="p-2 whitespace-nowrap">{o.orderDate}</td>
                      <td className="p-2">{o.customer}</td>
                      <td className="p-2 text-xs text-sh-gray">{o.storeLocation ?? "—"}</td>
                      <td className="p-2 text-right tabular-nums">
                        {currency(o.creditedNet)}
                        {o.isSplit && (
                          <span
                            className="ml-1 text-[10px] text-sh-gold"
                            title="Split order — credited at 50%"
                          >
                            50%
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-sh-navy bg-sh-linen">
                    <td className="p-2 font-semibold text-sh-navy" colSpan={4}>
                      Period total
                    </td>
                    <td className="p-2 text-right font-semibold text-sh-navy tabular-nums">
                      {currency(totalCredited)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
