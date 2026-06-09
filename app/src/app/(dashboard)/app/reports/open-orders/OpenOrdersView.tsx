"use client";

// /app/src/app/(dashboard)/app/reports/open-orders/OpenOrdersView.tsx
//
// Client view for the open-orders report. Receives already-fetched data from
// the server component (no client fetch) and renders KPI cards + the sortable
// table. Currency formats via useMoneyFormatter so it honors the tenant locale.

import { KpiCard, ReportSection, ReportTable } from "@/components/report";
import type { ReportColumn } from "@/components/report";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import type { OpenOrdersReport } from "@/lib/reports/openOrders";

type PORow = OpenOrdersReport["purchaseOrders"][number];

export function OpenOrdersView({ data }: { data: OpenOrdersReport }) {
  const money = useMoneyFormatter();
  const { summary, customerDeposits: deposits, purchaseOrders } = data;

  const poColumns: ReportColumn<PORow>[] = [
    { key: "poNumber", label: "PO #", sortable: true },
    { key: "vendor", label: "Vendor", sortable: true },
    { key: "orderDate", label: "Ordered", sortable: true },
    {
      key: "expectedDate",
      label: "Expected",
      sortable: true,
      format: (row) => {
        if (!row.expectedDate) return "—";
        return row.isOverdue ? `${row.expectedDate} (overdue)` : row.expectedDate;
      },
    },
    { key: "itemCount", label: "Items", align: "right", sortable: true },
    {
      key: "totalCost",
      label: "Value",
      align: "right",
      sortable: true,
      format: (row) => money(row.totalCost, { whole: true }),
      csvFormat: (row) => row.totalCost,
    },
    { key: "status", label: "Status", sortable: true },
  ];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-serif font-semibold text-sh-black">Open Orders</h1>
        <p className="text-xs text-sh-gray mt-1 font-sans">
          Outstanding purchase orders and customer deposit balances
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Open POs" value={summary.totalPOs} />
        <KpiCard label="Total PO Value" value={money(summary.totalValue, { whole: true })} />
        <KpiCard
          label="Overdue POs"
          value={summary.overduePOs}
          comparison={
            summary.overduePOs > 0
              ? `${money(summary.overdueValue, { whole: true })} overdue value`
              : undefined
          }
          trend={summary.overduePOs > 0 ? "up" : "neutral"}
          positiveIsGood={false}
        />
        <KpiCard
          label="Customer Deposits Outstanding"
          value={money(deposits.totalOutstanding, { whole: true })}
          sub={`${deposits.orderCount} open orders`}
        />
      </div>

      <ReportSection
        title="Purchase Orders"
        description="All open purchase orders, excluding received and cancelled"
      >
        <ReportTable<PORow>
          columns={poColumns}
          rows={purchaseOrders}
          getRowKey={(row) => row.id}
          exportFilename="open-purchase-orders"
          emptyMessage="No open purchase orders."
        />
      </ReportSection>
    </div>
  );
}
