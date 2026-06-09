"use client";

// /app/src/app/(dashboard)/app/reports/returns/ReturnsView.tsx
//
// Client view for Returns Analysis. Filter-driven via tRPC (runs on "Run
// Report"). KPI strip (gross, returns, rate), a by-department/vendor table, and
// the most-returned products. MANAGER/ADMIN; gated server-side.
//
// IMPORTANT framing: a "return" here is an order marked Returned. If the business
// uses order-rewrite / credit workflows, those credits are also marked Returned
// and inflate the rate above true merchandise returns — the note below the KPIs
// states this so the number is never read as a clean merchandise-return rate
// without that caveat.

import { useState } from "react";
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

// Higher return rate is worse.
function rateColor(pct: number | null): string {
  if (pct === null) return "text-sh-gray";
  if (pct >= 20) return "text-red-700";
  if (pct >= 10) return "text-amber-600";
  return "text-green-700";
}

export function ReturnsView() {
  const money = useMoneyFormatter();
  const fmt = (v: number) => money(v, { whole: true });

  const [startDate, setStartDate] = useState(firstOfYearStr());
  const [endDate, setEndDate] = useState(todayStr());
  const [pivot, setPivot] = useState<Pivot>("department");

  type Committed = { startDate: string; endDate: string; pivot: Pivot };
  const [committed, setCommitted] = useState<Committed | null>(null);

  const query = api.reports.returnsAnalysis.useQuery(committed ?? { startDate, endDate, pivot }, {
    enabled: committed !== null,
  });
  const loading = query.isFetching;
  const data = query.data;

  const run = () => setCommitted({ startDate, endDate, pivot });
  const pivotLabel = pivot === "vendor" ? "Vendor" : "Department";

  return (
    <div className="space-y-6 font-serif">
      <nav className="text-sm text-sh-gray">
        <Link href="/app/reports" className="hover:underline">
          Reports
        </Link>
        <span className="mx-2">/</span>
        <span className="text-sh-black">Returns Analysis</span>
      </nav>
      <h1 className="text-2xl font-semibold text-sh-navy">Returns Analysis</h1>
      <p className="text-sm text-sh-gray">
        How much is coming back, and from where. Return rate = value of orders marked Returned
        divided by gross sales in the period.
      </p>

      <div className="flex flex-wrap items-end gap-4">
        <div>
          <label htmlFor="rStart" className="mb-1 block text-xs font-medium text-sh-gray">
            Start
          </label>
          <input
            id="rStart"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="min-h-[44px] rounded border border-gray-300 px-3 text-sm"
          />
        </div>
        <div>
          <label htmlFor="rEnd" className="mb-1 block text-xs font-medium text-sh-gray">
            End
          </label>
          <input
            id="rEnd"
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

      {data && !loading && (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="rounded-lg border border-sh-gray/20 bg-white p-4 shadow-sm">
              <div className="text-xs uppercase tracking-wide text-sh-gray">Gross sales</div>
              <div className="mt-1 text-2xl font-semibold text-sh-navy">
                {fmt(data.totals.grossSales)}
              </div>
            </div>
            <div className="rounded-lg border border-sh-gray/20 bg-white p-4 shadow-sm">
              <div className="text-xs uppercase tracking-wide text-sh-gray">Returns</div>
              <div className="mt-1 text-2xl font-semibold text-red-700">
                {fmt(data.totals.returns)}
              </div>
              <div className="text-xs text-sh-gray">
                {intFmt.format(data.totals.returnedUnits)} units
              </div>
            </div>
            <div className="rounded-lg border border-sh-gray/20 bg-white p-4 shadow-sm">
              <div className="text-xs uppercase tracking-wide text-sh-gray">Return rate</div>
              <div className={`mt-1 text-2xl font-semibold ${rateColor(data.totals.returnRate)}`}>
                {data.totals.returnRate === null ? "--" : `${data.totals.returnRate.toFixed(1)}%`}
              </div>
            </div>
          </div>

          <div className="rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
            Returns counts every order marked <strong>Returned</strong>. If you use order rewrites
            or store-credit workflows, those credits are also marked Returned and push this rate
            above your true merchandise-return rate. Use the per-department breakdown and
            most-returned products for the actionable signal.
          </div>

          {data.rows.length > 0 && (
            <div className="overflow-hidden rounded-lg border border-sh-gray/20 bg-white shadow-md">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-sh-gray/20 bg-sh-linen">
                    <th className="px-4 py-3 text-left font-semibold text-sh-gray">{pivotLabel}</th>
                    <th className="px-4 py-3 text-right font-semibold text-sh-gray">Gross sales</th>
                    <th className="px-4 py-3 text-right font-semibold text-sh-gray">Returns</th>
                    <th className="px-4 py-3 text-right font-semibold text-sh-gray">Return rate</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row, i) => (
                    <tr
                      key={row.key}
                      className={`border-b border-sh-gray/10 ${i % 2 === 1 ? "bg-sh-stripe" : ""}`}
                    >
                      <td className="px-4 py-3 font-semibold text-sh-navy">{row.key}</td>
                      <td className="px-4 py-3 text-right text-sh-gray">{fmt(row.grossSales)}</td>
                      <td className="px-4 py-3 text-right font-semibold">{fmt(row.returns)}</td>
                      <td
                        className={`px-4 py-3 text-right font-semibold ${rateColor(row.returnRate)}`}
                      >
                        {row.returnRate === null ? "--" : `${row.returnRate.toFixed(1)}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {data.topReturnedProducts.length > 0 && (
            <div>
              <h2 className="mb-2 text-lg font-semibold text-sh-navy">Most returned products</h2>
              <div className="overflow-hidden rounded-lg border border-sh-gray/20 bg-white shadow-md">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-sh-gray/20 bg-sh-linen">
                      <th className="px-4 py-3 text-left font-semibold text-sh-gray">Product</th>
                      <th className="px-4 py-3 text-right font-semibold text-sh-gray">Returns</th>
                      <th className="px-4 py-3 text-right font-semibold text-sh-gray">Units</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topReturnedProducts.map((p, i) => (
                      <tr
                        key={`${p.productNumber ?? "x"}-${i}`}
                        className={`border-b border-sh-gray/10 ${i % 2 === 1 ? "bg-sh-stripe" : ""}`}
                      >
                        <td className="px-4 py-3">
                          <div className="font-semibold text-sh-navy">{p.name}</div>
                          {p.productNumber && (
                            <div className="text-xs text-sh-gray">{p.productNumber}</div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right font-semibold">{fmt(p.returns)}</td>
                        <td className="px-4 py-3 text-right text-sh-gray">
                          {intFmt.format(p.returnedUnits)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {data.rows.length === 0 && (
            <p className="py-8 text-center text-sh-gray">
              No sales or returns in the selected period.
            </p>
          )}
        </>
      )}

      {committed === null && !loading && (
        <p className="py-16 text-center text-sh-gray">Pick a range and click Run Report</p>
      )}
    </div>
  );
}
