"use client";

// /app/src/app/(dashboard)/app/reports/unclassified-returns/UnclassifiedReturnsView.tsx
//
// Client view for the Unclassified Returns exception report (B3). Filter-
// driven via tRPC useQuery; the query only runs after "Run Report" (committed
// filters), matching every other date-range report. MANAGER/ADMIN data; the
// page already gated server-side.
//
// Every row here booked on the default-restock assumption (no Return record
// classified it) — this is the accountant's worklist to review and, for any
// return that was actually damaged/unsalvageable, correct via the manual
// transfer-out workflow or by classifying the Return record.

import { useState } from "react";
import Link from "next/link";
import { KpiCard, ReportSection, ReportTable } from "@/components/report";
import type { ReportColumn } from "@/components/report";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { api } from "@/lib/trpc/client";
import type { UnclassifiedReturnRow } from "@/lib/reports/unclassifiedReturns";

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}
function firstOfYearStr(): string {
  return new Date().toISOString().slice(0, 4) + "-01-01";
}

export function UnclassifiedReturnsView() {
  const money = useMoneyFormatter();
  const c = (v: number) => money(v, { whole: true });

  const [startDate, setStartDate] = useState(firstOfYearStr());
  const [endDate, setEndDate] = useState(todayStr());

  type Committed = { startDate: string; endDate: string };
  const [committed, setCommitted] = useState<Committed | null>(null);

  const query = api.reports.unclassifiedReturns.useQuery(committed ?? { startDate, endDate }, {
    enabled: committed !== null,
  });
  const loading = query.isFetching;
  const data = query.data;

  const columns: ReportColumn<UnclassifiedReturnRow>[] = [
    { key: "date", label: "Date", sortable: true, format: (r) => r.date ?? "—" },
    { key: "orderno", label: "Order #", sortable: true },
    { key: "store", label: "Store", sortable: true },
    { key: "customerName", label: "Customer", sortable: true },
    { key: "description", label: "Item", sortable: true },
    {
      key: "amount",
      label: "Amount",
      align: "right",
      sortable: true,
      format: (r) => c(r.amount),
      csvFormat: (r) => r.amount,
    },
    { key: "reason", label: "Why unclassified", sortable: true },
  ];

  return (
    <div className="space-y-6 font-serif">
      <nav className="text-sm text-sh-gray">
        <Link href="/app/reports" className="hover:underline">
          Reports
        </Link>
        <span className="mx-2">/</span>
        <span className="text-sh-black">Unclassified Returns</span>
      </nav>
      <h1 className="text-2xl font-semibold text-sh-navy">Unclassified Returns</h1>
      <p className="text-sm text-sh-gray">
        Every return in this list was booked on the default assumption that it&apos;s a restock —
        because no Return record classifies it (imported/historical returns carry none; a few native
        returns just haven&apos;t been inspected yet). Review and correct any that were actually
        written off.
      </p>

      <div className="flex flex-wrap items-end gap-4 rounded-xl border border-sh-gray/15 bg-white p-5">
        <div>
          <label
            htmlFor="urStart"
            className="mb-1 block text-xs font-semibold uppercase tracking-wider text-sh-gray"
          >
            Start
          </label>
          <input
            id="urStart"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="min-h-[44px] rounded-lg border border-sh-gray/30 px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label
            htmlFor="urEnd"
            className="mb-1 block text-xs font-semibold uppercase tracking-wider text-sh-gray"
          >
            End
          </label>
          <input
            id="urEnd"
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="min-h-[44px] rounded-lg border border-sh-gray/30 px-3 py-2 text-sm"
          />
        </div>
        <button
          type="button"
          onClick={() => setCommitted({ startDate, endDate })}
          disabled={loading}
          className="min-h-[44px] rounded-lg bg-sh-navy px-5 py-2 text-sm font-semibold text-white transition hover:bg-sh-blue disabled:opacity-50"
        >
          {loading ? "Loading..." : "Run Report"}
        </button>
      </div>

      {data && (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <KpiCard label="Unclassified Returns" value={data.totals.count} />
            <KpiCard label="Total Amount" value={c(data.totals.totalAmount)} />
          </div>
          <ReportSection
            title={`${data.totals.count} Unclassified Returns`}
            description="Sorted by amount, highest first — booked as restock by default"
          >
            <ReportTable<UnclassifiedReturnRow>
              columns={columns}
              rows={data.rows}
              getRowKey={(r) => r.lineItemId}
              exportFilename="unclassified-returns"
              emptyMessage="No unclassified returns in this range"
              pageSize={50}
            />
          </ReportSection>
        </>
      )}

      {committed === null && !loading && (
        <p className="py-16 text-center text-sh-gray">Pick a date range and click Run Report</p>
      )}
    </div>
  );
}
