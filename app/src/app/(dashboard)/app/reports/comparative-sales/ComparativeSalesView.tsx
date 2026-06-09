"use client";

// /app/src/app/(dashboard)/app/reports/comparative-sales/ComparativeSalesView.tsx
//
// Client view for the comparative-sales report. Filter-driven via tRPC useQuery;
// the query runs after "Run Report" (committed filters). Custom table because
// each period cell stacks sales + visitors + conversion. MANAGER/ADMIN; the page
// gated server-side.

import { useState } from "react";
import Link from "next/link";
import { Loader2, ArrowUp, ArrowDown } from "lucide-react";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { api } from "@/lib/trpc/client";

interface StorePeriodData {
  netSales: number;
  orderCount: number;
  itemCount: number;
  visitors: number;
}

const intFmt = new Intl.NumberFormat("en-US");

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function lastYearStr(d: string): string {
  const date = new Date(d);
  date.setFullYear(date.getFullYear() - 1);
  return date.toISOString().slice(0, 10);
}

function conversionPct(orders: number, visitors: number): number | null {
  if (visitors <= 0) return null;
  return (orders / visitors) * 100;
}

export function ComparativeSalesView() {
  const money = useMoneyFormatter();
  const fmt = (v: number) => money(v, { whole: true });

  const now = todayStr();
  const firstOfMonth = now.slice(0, 8) + "01";

  const [p1Start, setP1Start] = useState(firstOfMonth);
  const [p1End, setP1End] = useState(now);
  const [p2Start, setP2Start] = useState(lastYearStr(firstOfMonth));
  const [p2End, setP2End] = useState(lastYearStr(now));
  const [departmentId, setDepartmentId] = useState("");

  type Committed = {
    p1Start: string;
    p1End: string;
    p2Start: string;
    p2End: string;
    departmentId: number | null;
  };
  const [committed, setCommitted] = useState<Committed | null>(null);

  const query = api.reports.comparativeSales.useQuery(
    committed ?? { p1Start, p1End, p2Start, p2End, departmentId: null },
    { enabled: committed !== null },
  );
  const loading = query.isFetching;
  const data = query.data;

  const run = () =>
    setCommitted({
      p1Start,
      p1End,
      p2Start,
      p2End,
      departmentId: departmentId ? Number(departmentId) : null,
    });

  function VarianceBadge({ value, pct }: Readonly<{ value: number; pct: number | null }>) {
    if (value === 0 && pct === null) return <span className="text-sh-gray">--</span>;
    const isPositive = value >= 0;
    return (
      <span
        className={`flex items-center justify-end gap-1 ${isPositive ? "text-green-700" : "text-red-700"}`}
      >
        {isPositive ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
        {fmt(Math.abs(value))}
        {pct !== null && <span className="ml-1 text-xs">({Math.abs(pct).toFixed(1)}%)</span>}
      </span>
    );
  }

  function PeriodCell({
    cell,
    showConversion,
  }: Readonly<{ cell: StorePeriodData; showConversion: boolean }>) {
    const conv = conversionPct(cell.orderCount, cell.visitors);
    return (
      <div className="flex flex-col items-end leading-tight">
        <span className="text-sh-black">{fmt(cell.netSales)}</span>
        <span className="text-xs text-sh-gray">
          {cell.visitors > 0 ? `${intFmt.format(cell.visitors)} visitors` : "no traffic"}
        </span>
        {showConversion && conv !== null && (
          <span className="text-xs text-sh-gold" title="Orders divided by visitors">
            {conv.toFixed(1)}% conv
          </span>
        )}
      </div>
    );
  }

  function TrafficVariance({ p1, p2 }: Readonly<{ p1: number; p2: number }>) {
    if (p1 === 0 && p2 === 0) return null;
    const delta = p1 - p2;
    const pct = p2 > 0 ? (delta / p2) * 100 : null;
    const positive = delta >= 0;
    return (
      <span className={`text-xs ${positive ? "text-green-700" : "text-red-700"}`}>
        {positive ? "+" : "−"}
        {intFmt.format(Math.abs(delta))} visitors
        {pct !== null && ` (${positive ? "+" : "−"}${Math.abs(pct).toFixed(0)}%)`}
      </span>
    );
  }

  const showConversion = data ? !data.departmentFiltered : true;

  return (
    <div className="space-y-6 font-serif">
      <nav className="text-sm text-sh-gray">
        <Link href="/app/reports" className="hover:underline">
          Reports
        </Link>
        <span className="mx-2">/</span>
        <span className="text-sh-black">Comparative Sales</span>
      </nav>
      <h1 className="text-2xl font-semibold text-sh-navy">Comparative Sales</h1>

      <div className="flex flex-wrap items-end gap-4">
        <div>
          <label htmlFor="p1Start" className="mb-1 block text-xs font-medium text-sh-gray">
            Current Start
          </label>
          <input
            id="p1Start"
            type="date"
            value={p1Start}
            onChange={(e) => setP1Start(e.target.value)}
            className="min-h-[44px] rounded border border-gray-300 px-3 text-sm"
          />
        </div>
        <div>
          <label htmlFor="p1End" className="mb-1 block text-xs font-medium text-sh-gray">
            Current End
          </label>
          <input
            id="p1End"
            type="date"
            value={p1End}
            onChange={(e) => setP1End(e.target.value)}
            className="min-h-[44px] rounded border border-gray-300 px-3 text-sm"
          />
        </div>
        <div className="self-center px-2 text-sm font-semibold text-sh-gray">vs</div>
        <div>
          <label htmlFor="p2Start" className="mb-1 block text-xs font-medium text-sh-gray">
            Compare Start
          </label>
          <input
            id="p2Start"
            type="date"
            value={p2Start}
            onChange={(e) => setP2Start(e.target.value)}
            className="min-h-[44px] rounded border border-gray-300 px-3 text-sm"
          />
        </div>
        <div>
          <label htmlFor="p2End" className="mb-1 block text-xs font-medium text-sh-gray">
            Compare End
          </label>
          <input
            id="p2End"
            type="date"
            value={p2End}
            onChange={(e) => setP2End(e.target.value)}
            className="min-h-[44px] rounded border border-gray-300 px-3 text-sm"
          />
        </div>
        <div>
          <label htmlFor="dept" className="mb-1 block text-xs font-medium text-sh-gray">
            Department
          </label>
          <select
            id="dept"
            value={departmentId}
            onChange={(e) => setDepartmentId(e.target.value)}
            className="min-h-[44px] rounded border border-gray-300 px-3 text-sm"
          >
            <option value="">All Departments</option>
            {data?.departments.map((d) => {
              const [id, name] = d.split(":");
              return (
                <option key={id} value={id}>
                  {name}
                </option>
              );
            })}
          </select>
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
        <div className="overflow-hidden rounded-lg border border-sh-gray/20 bg-white shadow-md">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-sh-gray/20 bg-sh-linen">
                <th className="px-4 py-3 text-left font-semibold text-sh-gray">Store</th>
                <th className="px-4 py-3 text-right font-semibold text-sh-gray">
                  {data.period1Label}
                </th>
                <th className="px-4 py-3 text-right font-semibold text-sh-gray">
                  {data.period2Label}
                </th>
                <th className="px-4 py-3 text-right font-semibold text-sh-gray">Variance</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, i) => (
                <tr
                  key={row.store}
                  className={`border-b border-sh-gray/10 ${i % 2 === 1 ? "bg-sh-stripe" : ""}`}
                >
                  <td className="px-4 py-3 align-top font-semibold text-sh-navy">{row.store}</td>
                  <td className="px-4 py-3 text-right align-top">
                    <PeriodCell cell={row.period1} showConversion={showConversion} />
                  </td>
                  <td className="px-4 py-3 text-right align-top">
                    <PeriodCell cell={row.period2} showConversion={showConversion} />
                  </td>
                  <td className="px-4 py-3 text-right align-top">
                    <div className="flex flex-col items-end gap-0.5">
                      <VarianceBadge value={row.variance} pct={row.variancePct} />
                      <TrafficVariance p1={row.period1.visitors} p2={row.period2.visitors} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-sh-navy bg-sh-linen">
                <td className="px-4 py-3 align-top font-semibold text-sh-navy">Total</td>
                <td className="px-4 py-3 text-right align-top font-semibold text-sh-navy">
                  <PeriodCell cell={data.totals.period1} showConversion={showConversion} />
                </td>
                <td className="px-4 py-3 text-right align-top font-semibold text-sh-navy">
                  <PeriodCell cell={data.totals.period2} showConversion={showConversion} />
                </td>
                <td className="px-4 py-3 text-right align-top font-semibold">
                  <div className="flex flex-col items-end gap-0.5">
                    <VarianceBadge value={data.totals.variance} pct={data.totals.variancePct} />
                    <TrafficVariance
                      p1={data.totals.period1.visitors}
                      p2={data.totals.period2.visitors}
                    />
                  </div>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {data && !loading && data.departmentFiltered && (
        <p className="text-xs text-sh-gray">
          Visitor counts are store-wide foot traffic (door counters), not department-specific —
          conversion % is hidden while a department filter is active. Co-located counters for the
          same store are summed together. Customers who enter through a side or back entrance may be
          under-counted.
        </p>
      )}

      {data && !loading && !data.departmentFiltered && (
        <p className="text-xs text-sh-gray">
          Visitors = door-counter foot traffic (co-located counters summed into one store).
          Conversion % = orders ÷ visitors. Customers who enter through a side or back entrance may
          be under-counted, so conversion can run slightly low.
        </p>
      )}

      {data && !loading && data.rows.length === 0 && (
        <p className="py-8 text-center text-sh-gray">No sales data for the selected periods.</p>
      )}

      {committed === null && !loading && (
        <p className="py-16 text-center text-sh-gray">Pick two periods and click Run Report</p>
      )}
    </div>
  );
}
