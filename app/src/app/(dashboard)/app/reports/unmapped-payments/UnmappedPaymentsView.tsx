"use client";

// /app/src/app/(dashboard)/app/reports/unmapped-payments/UnmappedPaymentsView.tsx
//
// Client view for the Unmapped Payments exception report.
//
// Every row is money that will NOT appear in the sales journal: the payment's
// `paymentType` has no POS_PAYMENTS mapping row, so generateSalesJournal warns
// and skips it (lib/journalEntry.ts). The fix is a mapping row per row here,
// added on the GL mappings admin screen.
//
// Runs unfiltered on load, unlike the other date-range reports. The question is
// "how much money is missing from the books", and a default window answers that
// wrongly by construction — a tender that fell out of use last year is still
// absent from last year's journal. The date filter narrows; it does not gate.

import { useState } from "react";
import Link from "next/link";
import { KpiCard, ReportSection, ReportTable } from "@/components/report";
import type { ReportColumn } from "@/components/report";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { api } from "@/lib/trpc/client";
import type { UnmappedPaymentTypeRow } from "@/lib/reports/unmappedPayments";

export function UnmappedPaymentsView() {
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [applied, setApplied] = useState<{ startDate?: string; endDate?: string }>({});
  const money = useMoneyFormatter();

  const { data, isLoading, error } = api.reports.unmappedPayments.useQuery({
    startDate: applied.startDate || null,
    endDate: applied.endDate || null,
  });

  const columns: ReportColumn<UnmappedPaymentTypeRow>[] = [
    {
      key: "paymentType",
      label: "Payment type",
      sortable: true,
      format: (r) => r.paymentType || "(blank)",
    },
    { key: "count", label: "Payments", align: "right", sortable: true, format: (r) => r.count },
    {
      key: "totalAmount",
      label: "Amount",
      align: "right",
      sortable: true,
      format: (r) => money(r.totalAmount),
      // Unformatted for Excel, matching the other money reports.
      csvFormat: (r) => r.totalAmount,
    },
    { key: "firstSeen", label: "First seen", align: "right", sortable: true },
    { key: "lastSeen", label: "Last seen", align: "right", sortable: true },
  ];

  return (
    <ReportSection
      title="Unmapped Payments"
      description="Tender types with no POS_PAYMENTS GL mapping. Every payment below is missing from the sales journal — the generator warns and skips it. Add a mapping row for each type to bring the money onto the books."
    >
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="from" className="mb-1 block text-sm text-sh-gray">
            From (optional)
          </label>
          <input
            id="from"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="rounded-md border border-sh-brand-gray px-3 py-2"
          />
        </div>
        <div>
          <label htmlFor="to" className="mb-1 block text-sm text-sh-gray">
            To (optional)
          </label>
          <input
            id="to"
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="rounded-md border border-sh-brand-gray px-3 py-2"
          />
        </div>
        <button
          type="button"
          onClick={() => setApplied({ startDate, endDate })}
          className="rounded-md bg-sh-blue px-4 py-2 text-white"
        >
          Apply filter
        </button>
        {(applied.startDate || applied.endDate) && (
          <button
            type="button"
            onClick={() => {
              setStartDate("");
              setEndDate("");
              setApplied({});
            }}
            className="rounded-md border border-sh-brand-gray px-4 py-2"
          >
            All time
          </button>
        )}
      </div>

      {error && <p className="text-red-700">Could not load the report: {error.message}</p>}
      {isLoading && <p className="text-sh-gray">Loading…</p>}

      {data && (
        <>
          <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-3">
            <KpiCard
              label="Unmapped tender types"
              value={data.totals.distinctTypes.toLocaleString()}
            />
            <KpiCard label="Payments affected" value={data.totals.payments.toLocaleString()} />
            <KpiCard label="Amount off the books" value={money(data.totals.amount)} />
          </div>

          {data.rows.length === 0 ? (
            <p className="text-sh-gray">
              Every tender type in this range maps to a GL account. Nothing is being dropped from
              the journal.
            </p>
          ) : (
            <ReportTable columns={columns} rows={data.rows} getRowKey={(r) => r.paymentType} />
          )}

          {data.unusedMappingLabels.length > 0 && (
            <p className="mt-6 text-sm text-sh-gray">
              Configured mapping labels matching no payment:{" "}
              <strong>{data.unusedMappingLabels.join(", ")}</strong>. Not an error on its own — a
              deployment may keep a label for a tender it no longer takes — but a label that never
              matches, sitting next to a type that never maps, is often one rename away from being
              the same thing.
            </p>
          )}

          <p className="mt-6 text-sm text-sh-gray">
            Mappings live on{" "}
            <Link href="/app/admin/accounting/gl-mappings" className="underline">
              GL Mappings
            </Link>
            . Amounts are signed, so a refund-only tender shows a negative total.
          </p>
        </>
      )}
    </ReportSection>
  );
}
