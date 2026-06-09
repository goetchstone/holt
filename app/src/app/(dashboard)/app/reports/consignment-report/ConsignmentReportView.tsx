"use client";

// /app/src/app/(dashboard)/app/reports/consignment-report/ConsignmentReportView.tsx
//
// Client view for the consignment summary report. Data is fetched once
// server-side and passed in; this component renders the KPIs and two tables.
// ADMIN-only; the page gated server-side.

import Link from "next/link";
import { KpiCard, ReportSection, ReportTable } from "@/components/report";
import type { ReportColumn } from "@/components/report";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import type { ConsignmentSummaryResponse } from "@/lib/reports/consignmentSummary";

type VendorRow = ConsignmentSummaryResponse["byVendor"][number];
type StatusRow = ConsignmentSummaryResponse["statusCounts"][number];

const STATUS_LABEL: Record<string, string> = {
  ON_FLOOR: "On Floor",
  ON_APPROVAL: "On Approval",
  SOLD: "Sold",
  PAID: "Paid",
  RETURNED_VENDOR: "Returned",
  MISSING: "Missing",
};

export function ConsignmentReportView({ data }: Readonly<{ data: ConsignmentSummaryResponse }>) {
  const money = useMoneyFormatter();
  const fmt = (v: number) => money(v);
  const totals = data.totals;

  const vendorColumns: ReportColumn<VendorRow>[] = [
    { key: "vendorName", label: "Vendor", sortable: true },
    { key: "onFloor", label: "On Floor", align: "right", sortable: true },
    { key: "onApproval", label: "On Approval", align: "right", sortable: true },
    { key: "sold", label: "Sold (unpaid)", align: "right", sortable: true },
    { key: "totalItems", label: "Total Items", align: "right", sortable: true },
    {
      key: "floorValue",
      label: "Floor Value",
      align: "right",
      sortable: true,
      format: (row) => fmt(row.floorValue),
      csvFormat: (row) => row.floorValue,
    },
    {
      key: "soldValue",
      label: "Outstanding Value",
      align: "right",
      sortable: true,
      format: (row) => fmt(row.soldValue),
      csvFormat: (row) => row.soldValue,
    },
  ];

  const statusColumns: ReportColumn<StatusRow>[] = [
    {
      key: "status",
      label: "Status",
      sortable: false,
      format: (row) => STATUS_LABEL[row.status] ?? row.status,
    },
    { key: "count", label: "Count", align: "right", sortable: true },
    {
      key: "totalCost",
      label: "Total Cost",
      align: "right",
      sortable: true,
      format: (row) => fmt(row.totalCost),
      csvFormat: (row) => row.totalCost,
    },
  ];

  return (
    <div className="space-y-8 font-serif">
      <nav className="text-sm text-sh-gray">
        <Link href="/app/reports" className="hover:underline">
          Reports
        </Link>
        <span className="mx-2">/</span>
        <span className="text-sh-black">Consignment Summary</span>
      </nav>
      <h1 className="text-2xl font-semibold text-sh-navy">Consignment Summary</h1>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Items on Floor" value={totals.onFloor} />
        <KpiCard
          label="Sold (unpaid)"
          value={totals.sold}
          href="/app/inventory/consignment/unpaid-sales"
        />
        <KpiCard
          label="Outstanding Balance"
          value={fmt(totals.outstandingValue)}
          positiveIsGood={false}
          sub={`${totals.outstanding} items owed to vendors`}
        />
        <KpiCard
          label="Paid This Year"
          value={fmt(totals.paidThisYearValue)}
          sub={`${totals.paidThisYear} items`}
        />
      </div>

      <ReportSection
        title="By Vendor"
        description="Inventory breakdown and outstanding obligations per consignment vendor"
      >
        <ReportTable<VendorRow>
          columns={vendorColumns}
          rows={data.byVendor}
          exportFilename="consignment-by-vendor"
          getRowKey={(row) => row.vendorId}
          totalsRow={{
            vendorName: "Total",
            onFloor: data.byVendor.reduce((s, v) => s + v.onFloor, 0),
            onApproval: data.byVendor.reduce((s, v) => s + v.onApproval, 0),
            sold: data.byVendor.reduce((s, v) => s + v.sold, 0),
            totalItems: totals.totalItems,
            floorValue: fmt(data.byVendor.reduce((s, v) => s + v.floorValue, 0)),
            soldValue: fmt(totals.outstandingValue),
          }}
        />
      </ReportSection>

      <ReportSection title="By Status" description="All items grouped by current lifecycle status">
        <ReportTable<StatusRow>
          columns={statusColumns}
          rows={data.statusCounts}
          exportFilename="consignment-by-status"
          getRowKey={(row) => row.status}
          totalsRow={{
            status: "Total",
            count: totals.totalItems,
            totalCost: fmt(data.statusCounts.reduce((s, r) => s + r.totalCost, 0)),
          }}
        />
      </ReportSection>
    </div>
  );
}
