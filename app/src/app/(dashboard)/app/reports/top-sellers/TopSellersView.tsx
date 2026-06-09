"use client";

// /app/src/app/(dashboard)/app/reports/top-sellers/TopSellersView.tsx
//
// Client view for Top & Bottom Sellers. Filter-driven via tRPC (runs on "Run
// Report"). Metric selector (revenue/units/margin), date range, and a department
// filter — the filter matters because delivery/labor/freight appear as "products"
// and otherwise dominate; pick a merchandise department to focus. Two tables: best
// and worst by the chosen metric. MANAGER/ADMIN; gated server-side.

import { useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { api } from "@/lib/trpc/client";
import type { TopSellerRow, TopSellersMetric } from "@/lib/reports/topSellers";

const intFmt = new Intl.NumberFormat("en-US");

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}
function firstOfYearStr(): string {
  return new Date().toISOString().slice(0, 4) + "-01-01";
}

const METRIC_LABEL: Record<TopSellersMetric, string> = {
  revenue: "Revenue",
  units: "Units",
  margin: "Margin",
};

export function TopSellersView() {
  const money = useMoneyFormatter();
  const fmt = (v: number) => money(v, { whole: true });

  const [startDate, setStartDate] = useState(firstOfYearStr());
  const [endDate, setEndDate] = useState(todayStr());
  const [metric, setMetric] = useState<TopSellersMetric>("revenue");
  const [department, setDepartment] = useState("");

  type Committed = {
    startDate: string;
    endDate: string;
    metric: TopSellersMetric;
    departments: string[];
  };
  const [committed, setCommitted] = useState<Committed | null>(null);

  const deptQuery = api.reports.departments.useQuery();
  const query = api.reports.topSellers.useQuery(
    committed ?? { startDate, endDate, metric, departments: [] },
    { enabled: committed !== null },
  );
  const loading = query.isFetching;
  const data = query.data;

  const run = () =>
    setCommitted({ startDate, endDate, metric, departments: department ? [department] : [] });

  function SellersTable({ title, rows }: Readonly<{ title: string; rows: TopSellerRow[] }>) {
    return (
      <div>
        <h2 className="mb-2 text-lg font-semibold text-sh-navy">{title}</h2>
        <div className="overflow-hidden rounded-lg border border-sh-gray/20 bg-white shadow-md">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-sh-gray/20 bg-sh-linen">
                <th className="px-3 py-2 text-left font-semibold text-sh-gray">Product</th>
                <th className="px-3 py-2 text-left font-semibold text-sh-gray">Dept / Vendor</th>
                <th className="px-3 py-2 text-right font-semibold text-sh-gray">Units</th>
                <th className="px-3 py-2 text-right font-semibold text-sh-gray">Revenue</th>
                <th className="px-3 py-2 text-right font-semibold text-sh-gray">Margin</th>
                <th className="px-3 py-2 text-right font-semibold text-sh-gray">Margin %</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={`${r.productNumber ?? "x"}-${i}`}
                  className={`border-b border-sh-gray/10 ${i % 2 === 1 ? "bg-sh-stripe" : ""}`}
                >
                  <td className="px-3 py-2">
                    <div className="font-semibold text-sh-navy">{r.name}</div>
                    {r.productNumber && (
                      <div className="text-xs text-sh-gray">{r.productNumber}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-sh-gray">
                    {r.department}
                    <br />
                    {r.vendor}
                  </td>
                  <td className="px-3 py-2 text-right">{intFmt.format(r.units)}</td>
                  <td className="px-3 py-2 text-right">{fmt(r.revenue)}</td>
                  <td
                    className={`px-3 py-2 text-right font-semibold ${
                      r.margin < 0 ? "text-red-700" : ""
                    }`}
                  >
                    {fmt(r.margin)}
                  </td>
                  <td className="px-3 py-2 text-right text-sh-gray">
                    {r.marginPct === null ? "--" : `${r.marginPct.toFixed(1)}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 font-serif">
      <nav className="text-sm text-sh-gray">
        <Link href="/app/reports" className="hover:underline">
          Reports
        </Link>
        <span className="mx-2">/</span>
        <span className="text-sh-black">Top &amp; Bottom Sellers</span>
      </nav>
      <h1 className="text-2xl font-semibold text-sh-navy">Top &amp; Bottom Sellers</h1>
      <p className="text-sm text-sh-gray">
        Best and worst products by your chosen metric. Delivery, labor, and freight appear as
        products in sales data — pick a department to keep the ranking to real merchandise.
      </p>

      <div className="flex flex-wrap items-end gap-4">
        <div>
          <label htmlFor="tsStart" className="mb-1 block text-xs font-medium text-sh-gray">
            Start
          </label>
          <input
            id="tsStart"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="min-h-[44px] rounded border border-gray-300 px-3 text-sm"
          />
        </div>
        <div>
          <label htmlFor="tsEnd" className="mb-1 block text-xs font-medium text-sh-gray">
            End
          </label>
          <input
            id="tsEnd"
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="min-h-[44px] rounded border border-gray-300 px-3 text-sm"
          />
        </div>
        <div>
          <label htmlFor="tsMetric" className="mb-1 block text-xs font-medium text-sh-gray">
            Rank by
          </label>
          <select
            id="tsMetric"
            value={metric}
            onChange={(e) => setMetric(e.target.value as TopSellersMetric)}
            className="min-h-[44px] rounded border border-gray-300 px-3 text-sm"
          >
            <option value="revenue">Revenue</option>
            <option value="units">Units</option>
            <option value="margin">Margin</option>
          </select>
        </div>
        <div>
          <label htmlFor="tsDept" className="mb-1 block text-xs font-medium text-sh-gray">
            Department
          </label>
          <select
            id="tsDept"
            value={department}
            onChange={(e) => setDepartment(e.target.value)}
            className="min-h-[44px] rounded border border-gray-300 px-3 text-sm"
          >
            <option value="">All Departments</option>
            {deptQuery.data?.map((d) => (
              <option key={d.id} value={d.name}>
                {d.name}
              </option>
            ))}
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

      {data && !loading && (data.top.length > 0 || data.bottom.length > 0) && (
        <div className="space-y-6">
          <SellersTable
            title={`Top ${data.top.length} by ${METRIC_LABEL[data.metric]}`}
            rows={data.top}
          />
          <SellersTable
            title={`Bottom ${data.bottom.length} by ${METRIC_LABEL[data.metric]}`}
            rows={data.bottom}
          />
        </div>
      )}

      {data && !loading && data.top.length === 0 && (
        <p className="py-8 text-center text-sh-gray">No sales in the selected period.</p>
      )}

      {committed === null && !loading && (
        <p className="py-16 text-center text-sh-gray">Pick a range and click Run Report</p>
      )}
    </div>
  );
}
