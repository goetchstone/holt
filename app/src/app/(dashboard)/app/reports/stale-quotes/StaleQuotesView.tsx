"use client";

// /app/src/app/(dashboard)/app/reports/stale-quotes/StaleQuotesView.tsx
//
// Client view for the stale-quote cleanup report. Filter-driven via tRPC
// useQuery; like the original, the query only runs after the user clicks "Run
// Report" (committed filters), so changing a dropdown doesn't refetch until
// they commit. ADMIN-only data; the page already gated server-side.

import { useState } from "react";
import Link from "next/link";
import { KpiCard, ReportSection, ReportTable } from "@/components/report";
import type { ReportColumn } from "@/components/report";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { api } from "@/lib/trpc/client";
import type { StaleQuoteRow } from "@/lib/reports/staleQuotes";

export function StaleQuotesView() {
  const money = useMoneyFormatter();
  const c = (v: number) => money(v, { whole: true });

  const [minAge, setMinAge] = useState(30);
  const [minValue, setMinValue] = useState(0);
  // Committed filters — only set when "Run Report" is clicked, which enables
  // the query. Matches the original manual-run UX.
  const [committed, setCommitted] = useState<{ minAge: number; minValue: number } | null>(null);

  const query = api.reports.staleQuotes.useQuery(committed ?? { minAge, minValue }, {
    enabled: committed !== null,
  });
  const data = query.data;

  const columns: ReportColumn<StaleQuoteRow>[] = [
    { key: "orderno", label: "Quote #", sortable: true, format: (r) => r.orderno },
    { key: "customerName", label: "Customer", sortable: true },
    { key: "salesperson", label: "Salesperson", sortable: true },
    { key: "quoteDate", label: "Quote Date", sortable: true, format: (r) => r.quoteDate ?? "—" },
    {
      key: "ageDays",
      label: "Age",
      align: "right",
      sortable: true,
      format: (r) => `${r.ageDays}d`,
    },
    {
      key: "quoteValue",
      label: "Value",
      align: "right",
      sortable: true,
      format: (r) => c(r.quoteValue),
      csvFormat: (r) => r.quoteValue,
    },
    { key: "lineItemCount", label: "Items", align: "right", sortable: true },
  ];

  return (
    <div className="space-y-6 font-serif">
      <nav className="text-sm text-sh-gray">
        <Link href="/app/reports" className="hover:underline">
          Reports
        </Link>
        <span className="mx-2">/</span>
        <span className="text-sh-black">Stale Quote Cleanup</span>
      </nav>
      <h1 className="text-2xl font-semibold text-sh-navy">Stale Quote Cleanup</h1>
      <p className="text-sm text-sh-gray">
        Old quotes that need follow-up or closure. Clean the pipeline and surface forgotten
        opportunities.
      </p>

      <div className="flex flex-wrap items-end gap-4 rounded-xl border border-sh-gray/15 bg-white p-5">
        <div>
          <label
            htmlFor="min-age"
            className="mb-1 block text-xs font-semibold uppercase tracking-wider text-sh-gray"
          >
            Min Age
          </label>
          <select
            id="min-age"
            value={minAge}
            onChange={(e) => setMinAge(Number(e.target.value))}
            className="min-h-[44px] rounded-lg border border-sh-gray/30 px-3 py-2 text-sm"
          >
            <option value={30}>30+ days</option>
            <option value={60}>60+ days</option>
            <option value={90}>90+ days</option>
            <option value={180}>180+ days</option>
          </select>
        </div>
        <div>
          <label
            htmlFor="min-value"
            className="mb-1 block text-xs font-semibold uppercase tracking-wider text-sh-gray"
          >
            Min Value
          </label>
          <select
            id="min-value"
            value={minValue}
            onChange={(e) => setMinValue(Number(e.target.value))}
            className="min-h-[44px] rounded-lg border border-sh-gray/30 px-3 py-2 text-sm"
          >
            <option value={0}>Any value</option>
            <option value={500}>$500+</option>
            <option value={1000}>$1,000+</option>
            <option value={5000}>$5,000+</option>
          </select>
        </div>
        <button
          type="button"
          onClick={() => setCommitted({ minAge, minValue })}
          disabled={query.isFetching}
          className="min-h-[44px] rounded-lg bg-sh-navy px-5 py-2 text-sm font-semibold text-white transition hover:bg-sh-blue disabled:opacity-50"
        >
          {query.isFetching ? "Loading..." : "Run Report"}
        </button>
      </div>

      {data && (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <KpiCard label="Stale Quotes" value={data.totals.total} />
            <KpiCard label="Total Value" value={c(data.totals.totalValue)} />
            <KpiCard label="Avg Age" value={`${data.totals.avgAge} days`} />
            <KpiCard label="Oldest" value={`${data.totals.oldestAge} days`} />
          </div>
          <ReportSection
            title={`${data.totals.total} Stale Quotes`}
            description="Sorted by value, highest first"
          >
            <ReportTable<StaleQuoteRow>
              columns={columns}
              rows={data.rows}
              getRowKey={(r) => r.id}
              exportFilename="stale-quotes"
              emptyMessage="No stale quotes matching filters"
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
