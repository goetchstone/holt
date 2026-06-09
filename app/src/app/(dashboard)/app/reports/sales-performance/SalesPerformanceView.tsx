"use client";

// /app/src/app/(dashboard)/app/reports/sales-performance/SalesPerformanceView.tsx
//
// Client view for the sales performance report. Filter-driven via tRPC useQuery;
// loads the last 30 days on mount and re-fetches when the user applies a new date
// range. Visible to any signed-in user; the page gated server-side.

import { useState } from "react";
import Link from "next/link";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
} from "chart.js";
import { Bar } from "react-chartjs-2";
import { format, subDays, startOfDay, endOfDay } from "date-fns";
import { KpiCard, ChartCard, ReportSection, ReportTable } from "@/components/report";
import type { ReportColumn } from "@/components/report";
import DateRangeFilter from "@/components/form/DateRangeFilter";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { api } from "@/lib/trpc/client";
import type { SalesPerformanceResponse } from "@/lib/reports/salesPerformance";

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend);

type StoreRow = SalesPerformanceResponse["byStore"][number];
type DeptRow = SalesPerformanceResponse["byDepartment"][number];

function trendDir(pct: number): "up" | "down" | "neutral" {
  if (pct > 0) return "up";
  if (pct < 0) return "down";
  return "neutral";
}

function fmtPct(pct: number): string {
  return pct >= 0 ? `+${pct}%` : `${pct}%`;
}

const defaultRange = {
  startDate: format(startOfDay(subDays(new Date(), 30)), "yyyy-MM-dd"),
  endDate: format(endOfDay(new Date()), "yyyy-MM-dd"),
};

export function SalesPerformanceView() {
  const money = useMoneyFormatter();
  const currency = (v: number) => money(v, { whole: true });

  const [dateRange, setDateRange] = useState(defaultRange);
  const [committed, setCommitted] = useState(defaultRange);

  const query = api.reports.salesPerformance.useQuery(committed);
  const loading = query.isFetching;
  const data = query.data;
  const kpis = data?.kpis;
  const isEmpty = !!data && data.dailyTrend.length === 0;

  const storeColumns: ReportColumn<StoreRow>[] = [
    { key: "store", label: "Store", sortable: true },
    {
      key: "totalSales",
      label: "Sales",
      align: "right",
      sortable: true,
      format: (row) => currency(row.totalSales),
      csvFormat: (row) => row.totalSales,
    },
    { key: "orderCount", label: "Orders", align: "right", sortable: true },
    {
      key: "avgOrder",
      label: "Avg Order",
      align: "right",
      sortable: true,
      format: (row) => currency(row.avgOrder),
      csvFormat: (row) => row.avgOrder,
    },
  ];

  const deptColumns: ReportColumn<DeptRow>[] = [
    { key: "department", label: "Department", sortable: true },
    {
      key: "totalSales",
      label: "Sales",
      align: "right",
      sortable: true,
      format: (row) => currency(row.totalSales),
      csvFormat: (row) => row.totalSales,
    },
    { key: "itemCount", label: "Items", align: "right", sortable: true },
  ];

  const chartData = {
    labels: (data?.dailyTrend ?? []).map((d) => d.date),
    datasets: [
      {
        label: "Daily Sales",
        data: (data?.dailyTrend ?? []).map((d) => d.totalSales),
        backgroundColor: "#A78A5A",
        borderRadius: 3,
      },
    ],
  };

  const chartOptions = {
    responsive: true,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (ctx: { parsed: { y: number | null } }) => currency(ctx.parsed.y ?? 0),
        },
      },
    },
    scales: {
      y: {
        ticks: {
          callback: (value: number | string) =>
            typeof value === "number" ? currency(value) : value,
        },
      },
    },
  };

  return (
    <div className="space-y-8 font-serif">
      <nav className="text-sm text-sh-gray">
        <Link href="/app/reports" className="hover:underline">
          Reports
        </Link>
        <span className="mx-2">/</span>
        <span className="text-sh-black">Sales Performance</span>
      </nav>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-sh-black">Sales Performance</h1>
          {data && (
            <p className="mt-1 font-sans text-xs text-sh-gray">
              {data.dateRange.start} — {data.dateRange.end}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <DateRangeFilter value={dateRange} onChange={setDateRange} />
          <button
            type="button"
            onClick={() => setCommitted(dateRange)}
            disabled={loading}
            className="min-h-[44px] shrink-0 rounded-lg bg-sh-navy px-5 py-2 text-sm font-semibold text-white transition hover:bg-sh-blue disabled:opacity-50"
          >
            {loading ? "Loading..." : "Run Report"}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
        <KpiCard
          label="Total Sales"
          value={kpis ? currency(kpis.totalSales) : "—"}
          sub={kpis ? `${kpis.orderCount} orders` : undefined}
        />
        <KpiCard label="Orders" value={kpis ? kpis.orderCount : "—"} />
        <KpiCard label="Avg Order" value={kpis ? currency(kpis.avgOrderValue) : "—"} />
        <KpiCard
          label="MTD Sales"
          value={kpis ? currency(kpis.mtdSales) : "—"}
          comparison={kpis ? `${fmtPct(kpis.mtdVsPrior)} vs prior year` : undefined}
          trend={kpis ? trendDir(kpis.mtdVsPrior) : undefined}
          positiveIsGood
        />
        <KpiCard
          label="YTD Sales"
          value={kpis ? currency(kpis.ytdSales) : "—"}
          comparison={kpis ? `${fmtPct(kpis.ytdVsPrior)} vs prior year` : undefined}
          trend={kpis ? trendDir(kpis.ytdVsPrior) : undefined}
          positiveIsGood
        />
      </div>

      <ChartCard
        title="Daily Sales Trend"
        subtitle={data ? `${data.dateRange.start} to ${data.dateRange.end}` : undefined}
        loading={loading}
        empty={isEmpty}
      >
        <Bar data={chartData} options={chartOptions} height={80} />
      </ChartCard>

      <ReportSection title="By Store">
        <ReportTable<StoreRow>
          columns={storeColumns}
          rows={data?.byStore ?? []}
          getRowKey={(row) => row.store}
          exportFilename="sales-by-store"
          emptyMessage={loading ? "Loading..." : "No store data for this period."}
        />
      </ReportSection>

      <ReportSection title="By Department">
        <ReportTable<DeptRow>
          columns={deptColumns}
          rows={data?.byDepartment ?? []}
          getRowKey={(row) => row.department}
          exportFilename="sales-by-department"
          emptyMessage={loading ? "Loading..." : "No department data for this period."}
        />
      </ReportSection>
    </div>
  );
}
