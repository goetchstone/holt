"use client";

// /app/src/app/(dashboard)/app/reports/po-gaps/PoGapsView.tsx
//
// Client view for the open-PO-gaps report. Data is fetched once server-side and
// passed in; the filter toggle is client-side over the in-memory rows (matches
// the original one-shot-then-filter UX). ADMIN-only; the page gated server-side.

import { useState } from "react";
import Link from "next/link";
import { KpiCard, ReportSection, ReportTable } from "@/components/report";
import type { ReportColumn } from "@/components/report";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import type { PoGapRow, PoGapsResult } from "@/lib/reports/poGaps";

type FilterMode = "all" | "missing-esd" | "missing-ack" | "furniture-only";

const FILTERS: [FilterMode, string][] = [
  ["furniture-only", "Furniture Gaps"],
  ["missing-esd", "All Missing ESD"],
  ["missing-ack", "All Missing Ack"],
  ["all", "All Open POs"],
];

export function PoGapsView({ data }: Readonly<{ data: PoGapsResult }>) {
  const money = useMoneyFormatter();
  const c = (v: number) => money(v, { whole: true });
  const [filter, setFilter] = useState<FilterMode>("furniture-only");

  const rows = data.rows.filter((r) => {
    if (filter === "missing-esd") return r.missingESD;
    if (filter === "missing-ack") return r.missingAck;
    if (filter === "furniture-only") return r.hasFurniture && (r.missingESD || r.missingAck);
    return true;
  });

  const missingCell = (value: string | null) =>
    value ? (
      <span className="text-sh-black">{value}</span>
    ) : (
      <span className="text-xs font-semibold text-red-600">MISSING</span>
    );

  const columns: ReportColumn<PoGapRow>[] = [
    {
      key: "poNumber",
      label: "PO #",
      sortable: true,
      render: (r) => (
        <Link
          href={`/app/purchasing/orders/${r.id}`}
          className="font-semibold text-sh-blue hover:underline"
        >
          {r.poNumber}
        </Link>
      ),
      csvFormat: (r) => r.poNumber,
    },
    { key: "vendorName", label: "Vendor", sortable: true },
    { key: "orderDate", label: "Order Date", sortable: true },
    {
      key: "expectedDelivery",
      label: "ESD",
      sortable: true,
      render: (r) => missingCell(r.expectedDelivery),
      csvFormat: (r) => r.expectedDelivery ?? "MISSING",
    },
    {
      key: "vendorAckNumber",
      label: "Ack #",
      sortable: true,
      render: (r) => missingCell(r.vendorAckNumber),
      csvFormat: (r) => r.vendorAckNumber ?? "MISSING",
    },
    { key: "lineItemCount", label: "Items", align: "right", sortable: true },
    {
      key: "totalCost",
      label: "Cost",
      align: "right",
      sortable: true,
      format: (r) => c(r.totalCost),
      csvFormat: (r) => r.totalCost,
    },
  ];

  return (
    <div className="space-y-6 font-serif">
      <nav className="text-sm text-sh-gray">
        <Link href="/app/reports" className="hover:underline">
          Reports
        </Link>
        <span className="mx-2">/</span>
        <span className="text-sh-black">Open PO Gaps</span>
      </nav>
      <h1 className="text-2xl font-semibold text-sh-navy">
        Open PO Gaps — Missing ESD &amp; Acknowledgement
      </h1>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <KpiCard label="Open POs" value={data.total} />
        <KpiCard
          label="Missing ESD"
          value={data.missingESD}
          sub={`${data.missingESDFurniture} furniture`}
        />
        <KpiCard
          label="Missing Ack #"
          value={data.missingAck}
          sub={`${data.missingAckFurniture} furniture`}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setFilter(value)}
            className={`min-h-[36px] rounded-full px-3 py-1.5 text-xs font-semibold transition ${
              filter === value
                ? "bg-sh-blue text-white"
                : "bg-sh-linen text-sh-gray hover:bg-sh-gray/10"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <ReportSection
        title={`${rows.length} POs`}
        description="Open POs missing ESD or acknowledgement"
      >
        <ReportTable<PoGapRow>
          columns={columns}
          rows={rows}
          getRowKey={(r) => r.id}
          exportFilename="po-gaps"
          emptyMessage="No POs match this filter."
          pageSize={50}
        />
      </ReportSection>
    </div>
  );
}
