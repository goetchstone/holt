"use client";

// /app/src/app/(dashboard)/app/reports/gross-margin/GrossMarginView.tsx
//
// Client view for the Gross Margin report. Filter-driven via tRPC useQuery; the
// query runs after "Run Report" (committed filters), same pattern as Comparative
// Sales. Pivot toggle switches the GROUP BY between department and vendor.
// MANAGER/ADMIN; the page is gated server-side. Margin % is colored by health and
// the footer totals the period. A low or 100% margin row is usually a data signal
// (missing cost on the product) — called out below the table.

import { useMemo, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { api } from "@/lib/trpc/client";

type Pivot = "department" | "vendor";

const intFmt = new Intl.NumberFormat("en-US");

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}
function firstOfYearStr(): string {
  return new Date().toISOString().slice(0, 4) + "-01-01";
}

// Margin health bands — luxury furniture runs ~45-55% blended; under 25% is thin,
// over 90% almost always means cost wasn't loaded on the product.
function marginColor(pct: number | null): string {
  if (pct === null) return "text-sh-gray";
  if (pct >= 90) return "text-amber-600"; // suspiciously high → likely missing cost
  if (pct >= 45) return "text-green-700";
  if (pct >= 25) return "text-sh-black";
  return "text-red-700";
}

export function GrossMarginView() {
  const money = useMoneyFormatter();
  const fmt = (v: number) => money(v, { whole: true });

  const [startDate, setStartDate] = useState(firstOfYearStr());
  const [endDate, setEndDate] = useState(todayStr());
  const [pivot, setPivot] = useState<Pivot>("department");

  type Committed = { startDate: string; endDate: string; pivot: Pivot };
  const [committed, setCommitted] = useState<Committed | null>(null);

  const query = api.reports.grossMargin.useQuery(committed ?? { startDate, endDate, pivot }, {
    enabled: committed !== null,
  });
  const loading = query.isFetching;
  const data = query.data;

  const run = () => setCommitted({ startDate, endDate, pivot });

  const hasSuspiciousMargin = useMemo(
    () => (data?.rows ?? []).some((r) => r.marginPct !== null && r.marginPct >= 90),
    [data],
  );

  const pivotLabel = pivot === "vendor" ? "Vendor" : "Department";

  return (
    <div className="space-y-6 font-serif">
      <nav className="text-sm text-sh-gray">
        <Link href="/app/reports" className="hover:underline">
          Reports
        </Link>
        <span className="mx-2">/</span>
        <span className="text-sh-black">Gross Margin</span>
      </nav>
      <h1 className="text-2xl font-semibold text-sh-navy">Gross Margin</h1>
      <p className="text-sm text-sh-gray">
        Revenue, cost, and margin for the period — where the profit actually comes from. Cancelled
        lines are excluded.
      </p>

      <div className="flex flex-wrap items-end gap-4">
        <div>
          <label htmlFor="gmStart" className="mb-1 block text-xs font-medium text-sh-gray">
            Start
          </label>
          <input
            id="gmStart"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="min-h-[44px] rounded border border-gray-300 px-3 text-sm"
          />
        </div>
        <div>
          <label htmlFor="gmEnd" className="mb-1 block text-xs font-medium text-sh-gray">
            End
          </label>
          <input
            id="gmEnd"
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="min-h-[44px] rounded border border-gray-300 px-3 text-sm"
          />
        </div>
        <div>
          <span className="mb-1 block text-xs font-medium text-sh-gray">Group by</span>
          <div className="inline-flex overflow-hidden rounded border border-gray-300">
            {(["department", "vendor"] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPivot(p)}
                className={`min-h-[44px] px-4 text-sm capitalize transition ${
                  pivot === p ? "bg-sh-navy text-white" : "bg-white text-sh-black hover:bg-sh-linen"
                }`}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
        <button
          type="button"
          onClick={run}
          disabled={loading}
          className="min-h-[44px] rounded-lg bg-sh-navy px-5 py-2 text-sm font-semibold text-white transition hover:bg-sh-blue disabled:opacity-50"
        >
          {loading ? "Loading..." : "Run Report"}
        </button>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-sh-gold" />
        </div>
      )}

      {data && !loading && data.rows.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-sh-gray/20 bg-white shadow-md">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-sh-gray/20 bg-sh-linen">
                <th className="px-4 py-3 text-left font-semibold text-sh-gray">{pivotLabel}</th>
                <th className="px-4 py-3 text-right font-semibold text-sh-gray">Revenue</th>
                <th className="px-4 py-3 text-right font-semibold text-sh-gray">Cost</th>
                <th className="px-4 py-3 text-right font-semibold text-sh-gray">Margin</th>
                <th className="px-4 py-3 text-right font-semibold text-sh-gray">Margin %</th>
                <th className="px-4 py-3 text-right font-semibold text-sh-gray">Units</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, i) => (
                <tr
                  key={row.key}
                  className={`border-b border-sh-gray/10 ${i % 2 === 1 ? "bg-sh-stripe" : ""}`}
                >
                  <td className="px-4 py-3 font-semibold text-sh-navy">{row.key}</td>
                  <td className="px-4 py-3 text-right">{fmt(row.revenue)}</td>
                  <td className="px-4 py-3 text-right text-sh-gray">{fmt(row.cost)}</td>
                  <td className="px-4 py-3 text-right font-semibold">{fmt(row.margin)}</td>
                  <td
                    className={`px-4 py-3 text-right font-semibold ${marginColor(row.marginPct)}`}
                  >
                    {row.marginPct === null ? "--" : `${row.marginPct.toFixed(1)}%`}
                  </td>
                  <td className="px-4 py-3 text-right text-sh-gray">{intFmt.format(row.units)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-sh-navy bg-sh-linen font-semibold text-sh-navy">
                <td className="px-4 py-3">Total</td>
                <td className="px-4 py-3 text-right">{fmt(data.totals.revenue)}</td>
                <td className="px-4 py-3 text-right">{fmt(data.totals.cost)}</td>
                <td className="px-4 py-3 text-right">{fmt(data.totals.margin)}</td>
                <td className={`px-4 py-3 text-right ${marginColor(data.totals.marginPct)}`}>
                  {data.totals.marginPct === null ? "--" : `${data.totals.marginPct.toFixed(1)}%`}
                </td>
                <td className="px-4 py-3 text-right">{intFmt.format(data.totals.units)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {data && !loading && hasSuspiciousMargin && (
        <p className="text-xs text-sh-gray">
          Rows at 90%+ margin (amber) usually mean cost wasn&apos;t recorded on those products, not
          that they&apos;re unusually profitable — worth a look in the catalog. Red rows are under
          25% margin.
        </p>
      )}

      {data && !loading && data.rows.length === 0 && (
        <p className="py-8 text-center text-sh-gray">No sales data for the selected period.</p>
      )}

      {committed === null && !loading && (
        <p className="py-16 text-center text-sh-gray">Pick a date range and click Run Report</p>
      )}
    </div>
  );
}
