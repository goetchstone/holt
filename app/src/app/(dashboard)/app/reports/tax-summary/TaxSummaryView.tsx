"use client";

// /app/src/app/(dashboard)/app/reports/tax-summary/TaxSummaryView.tsx
//
// Client view for the tax summary report. Filter-driven via tRPC useQuery; loads
// year-to-date on mount and re-fetches when the user applies a new date range.
// Visible to any signed-in user; the page gated server-side.

import { useState } from "react";
import Link from "next/link";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  LineElement,
  PointElement,
  Title,
  Tooltip,
  Legend,
} from "chart.js";
import { Line } from "react-chartjs-2";
import { KpiCard, ChartCard, ReportSection, ReportTable } from "@/components/report";
import type { ReportColumn } from "@/components/report";
import DateRangeFilter from "@/components/form/DateRangeFilter";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { api } from "@/lib/trpc/client";
import type { TaxSummaryResponse } from "@/lib/reports/taxSummary";

ChartJS.register(CategoryScale, LinearScale, LineElement, PointElement, Title, Tooltip, Legend);

type MonthRow = TaxSummaryResponse["byMonth"][number];
type StoreRow = TaxSummaryResponse["byStore"][number];
type JurisdictionRow = TaxSummaryResponse["byJurisdiction"][number];

const today = new Date();
const defaultDateRange = {
  startDate: `${today.getFullYear()}-01-01`,
  endDate: today.toISOString().slice(0, 10),
};

export function TaxSummaryView() {
  const money = useMoneyFormatter();
  const currency = (v: number) => money(v, { whole: true });

  const [dateRange, setDateRange] = useState(defaultDateRange);
  const [committed, setCommitted] = useState(defaultDateRange);

  const query = api.reports.taxSummary.useQuery(committed);
  const loading = query.isFetching;
  const data = query.data;

  const totals = data?.totals;
  const byMonth = data?.byMonth ?? [];
  const byStore = data?.byStore ?? [];
  const byJurisdiction = data?.byJurisdiction ?? [];

  const avgPerInvoice =
    totals && totals.invoiceCount > 0
      ? Math.round((totals.taxCollected / totals.invoiceCount) * 100) / 100
      : 0;

  const monthColumns: ReportColumn<MonthRow>[] = [
    { key: "month", label: "Month", sortable: true },
    { key: "invoiceCount", label: "Invoices", align: "right", sortable: true },
    {
      key: "taxCollected",
      label: "Tax Collected",
      align: "right",
      sortable: true,
      format: (row) => currency(row.taxCollected),
      csvFormat: (row) => row.taxCollected,
    },
  ];

  const storeColumns: ReportColumn<StoreRow>[] = [
    { key: "store", label: "Store", sortable: true },
    { key: "invoiceCount", label: "Invoices", align: "right", sortable: true },
    {
      key: "taxCollected",
      label: "Tax Collected",
      align: "right",
      sortable: true,
      format: (row) => currency(row.taxCollected),
      csvFormat: (row) => row.taxCollected,
    },
  ];

  const jurisdictionColumns: ReportColumn<JurisdictionRow>[] = [
    { key: "jurisdiction", label: "Jurisdiction", sortable: true },
    { key: "invoiceCount", label: "Invoices", align: "right", sortable: true },
    {
      key: "taxCollected",
      label: "Tax Collected",
      align: "right",
      sortable: true,
      format: (row) => currency(row.taxCollected),
      csvFormat: (row) => row.taxCollected,
    },
  ];

  const chartData = {
    labels: byMonth.map((r) => r.month),
    datasets: [
      {
        label: "Tax Collected",
        data: byMonth.map((r) => r.taxCollected),
        borderColor: "#00263E",
        backgroundColor: "rgba(0,38,62,0.08)",
        tension: 0.3,
        pointRadius: 4,
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
          callback: (value: string | number) => currency(Number(value)),
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
        <span className="text-sh-black">Tax Summary</span>
      </nav>
      <div>
        <h1 className="text-2xl font-semibold text-sh-black">Tax Summary</h1>
        <p className="mt-1 font-sans text-xs text-sh-gray">
          Tax collected by period and store, sourced from invoices
        </p>
      </div>

      <div className="rounded-xl border border-sh-gray/15 bg-white p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="flex-1">
            <DateRangeFilter value={dateRange} onChange={setDateRange} />
          </div>
          <button
            type="button"
            onClick={() => setCommitted(dateRange)}
            disabled={loading}
            className="min-h-[44px] rounded-lg bg-sh-navy px-5 py-2 font-sans text-sm font-semibold text-white transition-colors hover:bg-sh-blue disabled:opacity-50"
          >
            {loading ? "Loading..." : "Apply"}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard
          label="Total Tax Collected"
          value={loading ? "—" : totals ? currency(totals.taxCollected) : "—"}
        />
        <KpiCard label="Invoices" value={loading ? "—" : (totals?.invoiceCount ?? "—")} />
        <KpiCard
          label="Avg per Invoice"
          value={loading ? "—" : totals ? currency(avgPerInvoice) : "—"}
        />
        <KpiCard label="Orders Invoiced" value={loading ? "—" : (totals?.orderCount ?? "—")} />
      </div>

      <ChartCard
        title="Monthly Tax Trend"
        subtitle="Tax collected per invoice month"
        loading={loading}
        empty={!loading && byMonth.length === 0}
      >
        <Line data={chartData} options={chartOptions} />
      </ChartCard>

      <ReportSection title="By Month" description="Tax and invoice count grouped by invoice month">
        <ReportTable<MonthRow>
          columns={monthColumns}
          rows={byMonth}
          getRowKey={(row) => row.month}
          exportFilename="tax-summary-by-month"
          emptyMessage={loading ? "Loading..." : "No data for this period."}
          totalsRow={
            totals
              ? {
                  month: "Total",
                  invoiceCount: totals.invoiceCount,
                  taxCollected: currency(totals.taxCollected),
                }
              : undefined
          }
        />
      </ReportSection>

      <ReportSection title="By Store" description="Tax and invoice count grouped by store location">
        <ReportTable<StoreRow>
          columns={storeColumns}
          rows={byStore}
          getRowKey={(row) => row.store}
          exportFilename="tax-summary-by-store"
          emptyMessage={loading ? "Loading..." : "No data for this period."}
        />
      </ReportSection>

      <ReportSection
        title="By Jurisdiction"
        description="Tax collected grouped by tax district or exemption reason"
      >
        <ReportTable<JurisdictionRow>
          columns={jurisdictionColumns}
          rows={byJurisdiction}
          getRowKey={(row) => row.jurisdiction}
          exportFilename="tax-summary-by-jurisdiction"
          emptyMessage={loading ? "Loading..." : "No data for this period."}
        />
      </ReportSection>

      <p className="font-sans text-xs text-sh-gray">
        Tax figures sourced from invoices. Based on invoice date, not payment date.
      </p>
    </div>
  );
}
