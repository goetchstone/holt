"use client";

// /app/src/app/(dashboard)/app/reports/top-sellers/TopSellersView.tsx
//
// Client view for Top & Bottom Sellers. Filter-driven via tRPC (runs on "Run
// Report"). Metric selector (revenue/units/margin), date range, and a department
// filter — the filter matters because delivery/labor/freight appear as "products"
// and otherwise dominate; pick a merchandise department to focus. Two tables: best
// and worst by the chosen metric. MANAGER/ADMIN; gated server-side. Margin,
// margin % and the margin ranking only for a viewer holding "View cost": the
// response says which (costVisible), the server left the figures out otherwise,
// and answers a margin ranking by revenue (data.metric names what was used).

import { useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { keepPreviousData } from "@tanstack/react-query";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { api } from "@/lib/trpc/client";
import { CostHiddenNote } from "@/components/ui/CostHiddenNote";
import type { TopSellerRow, TopSellersMetric } from "@/lib/reports/topSellers";

type CostField = "cost" | "margin" | "marginPct";
type Row = Omit<TopSellerRow, CostField> & Partial<Pick<TopSellerRow, CostField>>;

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
    // Keep the last answer while a new range loads, so whether cost is visible
    // stays known and the Margin option does not flicker back.
    { enabled: committed !== null, placeholderData: keepPreviousData },
  );
  const loading = query.isFetching;
  const data = query.data;
  // null until the first answer; the Margin option shows until it says no.
  const costVisible: boolean | null = data ? data.costVisible : null;
  const effectiveMetric: TopSellersMetric =
    costVisible === false && metric === "margin" ? "revenue" : metric;

  const run = () =>
    setCommitted({
      startDate,
      endDate,
      metric: effectiveMetric,
      departments: department ? [department] : [],
    });

  function SellersTable({ title, rows }: Readonly<{ title: string; rows: Row[] }>) {
    return (
      <div>
        <h2 className="mb-2 text-lg font-semibold text-brand-navy">{title}</h2>
        <div className="overflow-hidden rounded-lg border border-brand-gray/20 bg-white shadow-md">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-brand-gray/20 bg-brand-linen">
                <th className="px-3 py-2 text-left font-semibold text-brand-gray">Product</th>
                <th className="px-3 py-2 text-left font-semibold text-brand-gray">Dept / Vendor</th>
                <th className="px-3 py-2 text-right font-semibold text-brand-gray">Units</th>
                <th className="px-3 py-2 text-right font-semibold text-brand-gray">Revenue</th>
                {costVisible === true && (
                  <>
                    <th className="px-3 py-2 text-right font-semibold text-brand-gray">Margin</th>
                    <th className="px-3 py-2 text-right font-semibold text-brand-gray">Margin %</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={`${r.productNumber ?? "x"}-${i}`}
                  className={`border-b border-brand-gray/10 ${i % 2 === 1 ? "bg-brand-stripe" : ""}`}
                >
                  <td className="px-3 py-2">
                    <div className="font-semibold text-brand-navy">{r.name}</div>
                    {r.productNumber && (
                      <div className="text-xs text-brand-gray">{r.productNumber}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-brand-gray">
                    {r.department}
                    <br />
                    {r.vendor}
                  </td>
                  <td className="px-3 py-2 text-right">{intFmt.format(r.units)}</td>
                  <td className="px-3 py-2 text-right">{fmt(r.revenue)}</td>
                  {costVisible === true && (
                    <>
                      <td
                        className={`px-3 py-2 text-right font-semibold ${
                          (r.margin ?? 0) < 0 ? "text-red-700" : ""
                        }`}
                      >
                        {fmt(r.margin ?? 0)}
                      </td>
                      <td className="px-3 py-2 text-right text-brand-gray">
                        {r.marginPct == null ? "--" : `${r.marginPct.toFixed(1)}%`}
                      </td>
                    </>
                  )}
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
      <nav className="text-sm text-brand-gray">
        <Link href="/app/reports" className="hover:underline">
          Reports
        </Link>
        <span className="mx-2">/</span>
        <span className="text-brand-black">Top &amp; Bottom Sellers</span>
      </nav>
      <h1 className="text-2xl font-semibold text-brand-navy">Top &amp; Bottom Sellers</h1>
      <p className="text-sm text-brand-gray">
        Best and worst products by your chosen metric. Delivery, labor, and freight appear as
        products in sales data — pick a department to keep the ranking to real merchandise.
      </p>

      <div className="flex flex-wrap items-end gap-4">
        <div>
          <label htmlFor="tsStart" className="mb-1 block text-xs font-medium text-brand-gray">
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
          <label htmlFor="tsEnd" className="mb-1 block text-xs font-medium text-brand-gray">
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
          <label htmlFor="tsMetric" className="mb-1 block text-xs font-medium text-brand-gray">
            Rank by
          </label>
          <select
            id="tsMetric"
            value={effectiveMetric}
            onChange={(e) => setMetric(e.target.value as TopSellersMetric)}
            className="min-h-[44px] rounded border border-gray-300 px-3 text-sm"
          >
            <option value="revenue">Revenue</option>
            <option value="units">Units</option>
            {costVisible !== false && <option value="margin">Margin</option>}
          </select>
        </div>
        <div>
          <label htmlFor="tsDept" className="mb-1 block text-xs font-medium text-brand-gray">
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
          className="min-h-[44px] rounded-lg bg-brand-navy px-5 py-2 text-sm font-semibold text-white transition hover:bg-brand-blue disabled:opacity-50"
        >
          {loading ? "Loading..." : "Run Report"}
        </button>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-brand-gold" />
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
        <p className="py-8 text-center text-brand-gray">No sales in the selected period.</p>
      )}

      {data && !loading && data.costVisible === false && <CostHiddenNote />}

      {committed === null && !loading && (
        <p className="py-16 text-center text-brand-gray">Pick a range and click Run Report</p>
      )}
    </div>
  );
}
