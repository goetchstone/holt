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
import { CostHiddenNote } from "@/components/ui/CostHiddenNote";
import type {
  ConsignmentSummaryForCaller,
  ConsignmentSummaryResponse,
} from "@/lib/reports/consignmentSummary";

// Values (what is owed and paid to consignors) are present only for a viewer
// holding "View cost"; the page says which (costVisible).
type Report = (ConsignmentSummaryResponse | ConsignmentSummaryForCaller) & {
  costVisible: boolean;
};
type VendorRow = ConsignmentSummaryForCaller["byVendor"][number] &
  Partial<Pick<ConsignmentSummaryResponse["byVendor"][number], "soldValue" | "floorValue">>;
type StatusRow = ConsignmentSummaryForCaller["statusCounts"][number] &
  Partial<Pick<ConsignmentSummaryResponse["statusCounts"][number], "totalCost">>;
type Totals = ConsignmentSummaryForCaller["totals"] &
  Partial<Pick<ConsignmentSummaryResponse["totals"], "outstandingValue" | "paidThisYearValue">>;

const STATUS_LABEL: Record<string, string> = {
  ON_FLOOR: "On Floor",
  ON_APPROVAL: "On Approval",
  SOLD: "Sold",
  PAID: "Paid",
  RETURNED_VENDOR: "Returned",
  MISSING: "Missing",
};

export function ConsignmentReportView({ data }: Readonly<{ data: Report }>) {
  const money = useMoneyFormatter();
  const fmt = (v: number) => money(v);
  const showCost = data.costVisible;
  const totals: Totals = data.totals;
  const byVendor: VendorRow[] = data.byVendor;
  const statusCounts: StatusRow[] = data.statusCounts;

  const vendorColumns: ReportColumn<VendorRow>[] = [
    { key: "vendorName", label: "Vendor", sortable: true },
    { key: "onFloor", label: "On Floor", align: "right", sortable: true },
    { key: "onApproval", label: "On Approval", align: "right", sortable: true },
    { key: "sold", label: "Sold (unpaid)", align: "right", sortable: true },
    { key: "totalItems", label: "Total Items", align: "right", sortable: true },
    ...(showCost
      ? ([
          {
            key: "floorValue",
            label: "Floor Value",
            align: "right",
            sortable: true,
            format: (row) => fmt(row.floorValue ?? 0),
            csvFormat: (row) => row.floorValue ?? 0,
          },
          {
            key: "soldValue",
            label: "Outstanding Value",
            align: "right",
            sortable: true,
            format: (row) => fmt(row.soldValue ?? 0),
            csvFormat: (row) => row.soldValue ?? 0,
          },
        ] satisfies ReportColumn<VendorRow>[])
      : []),
  ];

  const statusColumns: ReportColumn<StatusRow>[] = [
    {
      key: "status",
      label: "Status",
      sortable: false,
      format: (row) => STATUS_LABEL[row.status] ?? row.status,
    },
    { key: "count", label: "Count", align: "right", sortable: true },
    ...(showCost
      ? ([
          {
            key: "totalCost",
            label: "Total Cost",
            align: "right",
            sortable: true,
            format: (row) => fmt(row.totalCost ?? 0),
            csvFormat: (row) => row.totalCost ?? 0,
          },
        ] satisfies ReportColumn<StatusRow>[])
      : []),
  ];

  return (
    <div className="space-y-8 font-serif">
      <nav className="text-sm text-brand-gray">
        <Link href="/app/reports" className="hover:underline">
          Reports
        </Link>
        <span className="mx-2">/</span>
        <span className="text-brand-black">Consignment Summary</span>
      </nav>
      <h1 className="text-2xl font-semibold text-brand-navy">Consignment Summary</h1>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Items on Floor" value={totals.onFloor} />
        <KpiCard
          label="Sold (unpaid)"
          value={totals.sold}
          href="/app/inventory/consignment/unpaid-sales"
        />
        {showCost ? (
          <>
            <KpiCard
              label="Outstanding Balance"
              value={fmt(totals.outstandingValue ?? 0)}
              positiveIsGood={false}
              sub={`${totals.outstanding} items owed to vendors`}
            />
            <KpiCard
              label="Paid This Year"
              value={fmt(totals.paidThisYearValue ?? 0)}
              sub={`${totals.paidThisYear} items`}
            />
          </>
        ) : (
          <>
            <KpiCard
              label="Owed to Vendors"
              value={totals.outstanding}
              sub="items sold, not yet paid"
            />
            <KpiCard label="Paid This Year" value={totals.paidThisYear} sub="items" />
          </>
        )}
      </div>
      {!showCost && <CostHiddenNote />}

      <ReportSection
        title="By Vendor"
        description="Inventory breakdown and outstanding obligations per consignment vendor"
      >
        <ReportTable<VendorRow>
          columns={vendorColumns}
          rows={byVendor}
          exportFilename="consignment-by-vendor"
          getRowKey={(row) => row.vendorId}
          totalsRow={{
            vendorName: "Total",
            onFloor: byVendor.reduce((s, v) => s + v.onFloor, 0),
            onApproval: byVendor.reduce((s, v) => s + v.onApproval, 0),
            sold: byVendor.reduce((s, v) => s + v.sold, 0),
            totalItems: totals.totalItems,
            ...(showCost
              ? {
                  floorValue: fmt(byVendor.reduce((s, v) => s + (v.floorValue ?? 0), 0)),
                  soldValue: fmt(totals.outstandingValue ?? 0),
                }
              : {}),
          }}
        />
      </ReportSection>

      <ReportSection title="By Status" description="All items grouped by current lifecycle status">
        <ReportTable<StatusRow>
          columns={statusColumns}
          rows={statusCounts}
          exportFilename="consignment-by-status"
          getRowKey={(row) => row.status}
          totalsRow={{
            status: "Total",
            count: totals.totalItems,
            ...(showCost
              ? { totalCost: fmt(statusCounts.reduce((s, r) => s + (r.totalCost ?? 0), 0)) }
              : {}),
          }}
        />
      </ReportSection>
    </div>
  );
}
