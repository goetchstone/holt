"use client";

// /app/src/app/(dashboard)/app/reports/dormant-customers/DormantCustomersView.tsx
//
// Client view for the dormant-customer winback report. Filter-driven via tRPC
// useQuery; the query only runs after "Run Report" is clicked (committed
// filters), matching the original manual-run UX. MANAGER/ADMIN data; the page
// already gated server-side.

import { useState } from "react";
import Link from "next/link";
import { KpiCard, ReportSection, ReportTable } from "@/components/report";
import type { ReportColumn } from "@/components/report";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { api } from "@/lib/trpc/client";
import type { DormantRow } from "@/lib/reports/dormantCustomers";

type Committed = { minSpend: number; minMonths: number; maxMonths: number };

export function DormantCustomersView() {
  const money = useMoneyFormatter();
  const c = (v: number) => money(v, { whole: true });

  const [minSpend, setMinSpend] = useState(2000);
  const [window, setWindow] = useState("6-36");
  const [committed, setCommitted] = useState<Committed | null>(null);

  const query = api.reports.dormantCustomers.useQuery(
    committed ?? { minSpend, minMonths: 6, maxMonths: 36 },
    {
      enabled: committed !== null,
    },
  );
  const data = query.data;

  const run = () => {
    const [minMonths, maxMonths] = window.split("-").map(Number);
    setCommitted({ minSpend, minMonths, maxMonths });
  };

  const columns: ReportColumn<DormantRow>[] = [
    {
      key: "lastName",
      label: "Customer",
      sortable: true,
      format: (r) => [r.firstName, r.lastName].filter(Boolean).join(" ") || "Unknown",
    },
    { key: "phone", label: "Phone", format: (r) => r.phone ?? "—" },
    { key: "email", label: "Email", format: (r) => r.email ?? "—" },
    {
      key: "totalSpend",
      label: "Total Spend",
      align: "right",
      sortable: true,
      format: (r) => c(r.totalSpend),
      csvFormat: (r) => r.totalSpend,
    },
    { key: "orderCount", label: "Orders", align: "right", sortable: true },
    {
      key: "lastOrderDate",
      label: "Last Order",
      sortable: true,
      format: (r) => r.lastOrderDate ?? "—",
    },
    { key: "daysSinceLast", label: "Days Since", align: "right", sortable: true },
    {
      key: "topDepartment",
      label: "Top Dept",
      sortable: true,
      format: (r) => r.topDepartment ?? "—",
    },
    { key: "deptCount", label: "Depts", align: "right", sortable: true },
  ];

  return (
    <div className="space-y-6 font-serif">
      <nav className="text-sm text-sh-gray">
        <Link href="/app/reports" className="hover:underline">
          Reports
        </Link>
        <span className="mx-2">/</span>
        <span className="text-sh-black">Dormant Customer Winback</span>
      </nav>
      <h1 className="text-2xl font-semibold text-sh-navy">Dormant Customer Winback</h1>
      <p className="text-sm text-sh-gray">
        High-value customers who have not been back. Who should the team call today?
      </p>

      <div className="flex flex-wrap items-end gap-4 rounded-xl border border-sh-gray/15 bg-white p-5">
        <div>
          <label
            htmlFor="min-spend"
            className="mb-1 block text-xs font-semibold uppercase tracking-wider text-sh-gray"
          >
            Min Spend
          </label>
          <select
            id="min-spend"
            value={minSpend}
            onChange={(e) => setMinSpend(Number(e.target.value))}
            className="min-h-[44px] rounded-lg border border-sh-gray/30 px-3 py-2 text-sm"
          >
            <option value={1000}>$1,000+</option>
            <option value={2000}>$2,000+</option>
            <option value={5000}>$5,000+</option>
            <option value={10000}>$10,000+</option>
          </select>
        </div>
        <div>
          <label
            htmlFor="window"
            className="mb-1 block text-xs font-semibold uppercase tracking-wider text-sh-gray"
          >
            Dormancy Window
          </label>
          <select
            id="window"
            value={window}
            onChange={(e) => setWindow(e.target.value)}
            className="min-h-[44px] rounded-lg border border-sh-gray/30 px-3 py-2 text-sm"
          >
            <option value="6-12">6-12 months</option>
            <option value="6-36">6-36 months (all)</option>
            <option value="12-24">12-24 months</option>
            <option value="24-36">24-36 months</option>
          </select>
        </div>
        <button
          type="button"
          onClick={run}
          disabled={query.isFetching}
          className="min-h-[44px] rounded-lg bg-sh-navy px-5 py-2 text-sm font-semibold text-white transition hover:bg-sh-blue disabled:opacity-50"
        >
          {query.isFetching ? "Loading..." : "Run Report"}
        </button>
      </div>

      {data && (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <KpiCard label="Dormant VIPs (10K+)" value={data.totals.vipCount} />
            <KpiCard label="High Value (5-10K)" value={data.totals.highValueCount} />
            <KpiCard label="Total Past Spend" value={c(data.totals.totalPastSpend)} />
            <KpiCard label="Avg Days Since" value={data.totals.avgDays} />
          </div>
          <ReportSection
            title={`${data.totals.total} Dormant Customers`}
            description="Sorted by lifetime spend, highest first"
          >
            <ReportTable<DormantRow>
              columns={columns}
              rows={data.rows}
              getRowKey={(r) => r.id}
              exportFilename="dormant-customers"
              emptyMessage="No dormant customers matching filters"
              pageSize={50}
            />
          </ReportSection>
        </>
      )}

      {committed === null && (
        <p className="py-16 text-center text-sh-gray">Select filters and click Run Report</p>
      )}
    </div>
  );
}
