"use client";

// /app/src/app/(dashboard)/app/reports/cross-sell/CrossSellView.tsx
//
// Client view for the cross-sell opportunity report. Filter-driven via tRPC
// useQuery; the query only runs after "Run Report" is clicked (committed
// filters), matching the original manual-run UX. MANAGER/ADMIN data; the page
// already gated server-side.

import { useState } from "react";
import Link from "next/link";
import { KpiCard, ReportSection, ReportTable } from "@/components/report";
import type { ReportColumn } from "@/components/report";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { api } from "@/lib/trpc/client";
import type { CrossSellRow } from "@/lib/reports/crossSell";

type Committed = { target: string | null; minSpend: number };

export function CrossSellView() {
  const money = useMoneyFormatter();
  const c = (v: number) => money(v, { whole: true });

  const [target, setTarget] = useState("");
  const [minSpend, setMinSpend] = useState(1000);
  const [committed, setCommitted] = useState<Committed | null>(null);

  const query = api.reports.crossSell.useQuery(committed ?? { target: null, minSpend }, {
    enabled: committed !== null,
  });
  const data = query.data;

  const run = () => setCommitted({ target: target || null, minSpend });

  const columns: ReportColumn<CrossSellRow>[] = [
    {
      key: "lastName",
      label: "Customer",
      sortable: true,
      format: (r) => [r.firstName, r.lastName].filter(Boolean).join(" ") || "Unknown",
    },
    { key: "phone", label: "Phone", format: (r) => r.phone ?? "—" },
    { key: "email", label: "Email", format: (r) => r.email ?? "—" },
    {
      key: "furnitureSpend",
      label: "Furniture Spend",
      align: "right",
      sortable: true,
      format: (r) => c(r.furnitureSpend),
      csvFormat: (r) => r.furnitureSpend,
    },
    {
      key: "lastFurnitureOrder",
      label: "Last Furniture",
      sortable: true,
      format: (r) => r.lastFurnitureOrder ?? "—",
    },
    {
      key: "departmentsNotBought",
      label: "Opportunity",
      format: (r) => r.departmentsNotBought.join(", "),
    },
  ];

  return (
    <div className="space-y-6 font-serif">
      <nav className="text-sm text-sh-gray">
        <Link href="/app/reports" className="hover:underline">
          Reports
        </Link>
        <span className="mx-2">/</span>
        <span className="text-sh-black">Cross-Sell Opportunity</span>
      </nav>
      <h1 className="text-2xl font-semibold text-sh-navy">Cross-Sell Opportunity</h1>
      <p className="text-sm text-sh-gray">
        Furniture buyers who never bought from high-value complementary departments. Targeted
        outreach list.
      </p>

      <div className="flex flex-wrap items-end gap-4 rounded-xl border border-sh-gray/15 bg-white p-5">
        <div>
          <label
            htmlFor="target-dept"
            className="mb-1 block text-xs font-semibold uppercase tracking-wider text-sh-gray"
          >
            Target Department
          </label>
          <select
            id="target-dept"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="min-h-[44px] rounded-lg border border-sh-gray/30 px-3 py-2 text-sm"
          >
            <option value="">All missing departments</option>
            <option value="Rugs">Never bought Rugs</option>
            <option value="Curtains">Never bought Curtains</option>
            <option value="Outdoor Furniture">Never bought Outdoor</option>
            <option value="Lamps">Never bought Lamps</option>
            <option value="Bedding">Never bought Bedding</option>
            <option value="Womens Apparel">Never bought Womens Apparel</option>
            <option value="Mens Apparel">Never bought Mens Apparel</option>
            <option value="Home Acc">Never bought Home Acc</option>
          </select>
        </div>
        <div>
          <label
            htmlFor="min-furn-spend"
            className="mb-1 block text-xs font-semibold uppercase tracking-wider text-sh-gray"
          >
            Min Furniture Spend
          </label>
          <select
            id="min-furn-spend"
            value={minSpend}
            onChange={(e) => setMinSpend(Number(e.target.value))}
            className="min-h-[44px] rounded-lg border border-sh-gray/30 px-3 py-2 text-sm"
          >
            <option value={500}>$500+</option>
            <option value={1000}>$1,000+</option>
            <option value={2500}>$2,500+</option>
            <option value={5000}>$5,000+</option>
            <option value={10000}>$10,000+</option>
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
            <KpiCard label="Furniture Customers" value={data.totals.totalFurnCustomers} />
            <KpiCard label="Never Bought Rugs" value={data.totals.neverRugs} />
            <KpiCard label="Never Bought Curtains" value={data.totals.neverCurtains} />
            <KpiCard label="Opportunities" value={data.totals.total} />
          </div>
          <ReportSection
            title={`${data.totals.total} Cross-Sell Opportunities`}
            description="Furniture buyers missing complementary categories, sorted by spend"
          >
            <ReportTable<CrossSellRow>
              columns={columns}
              rows={data.rows}
              getRowKey={(r) => r.id}
              exportFilename="cross-sell-opportunity"
              emptyMessage="No cross-sell opportunities matching filters"
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
