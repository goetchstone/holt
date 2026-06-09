"use client";

// /app/src/app/(dashboard)/app/reports/balance-aging/BalanceAgingView.tsx
//
// Client view for the balance-due aging report. Receives server-fetched data
// and renders KPI cards + the sortable/exportable table. Currency via
// useMoneyFormatter (tenant locale, whole dollars to match the prior report).

import Link from "next/link";
import { KpiCard, ReportSection, ReportTable } from "@/components/report";
import type { ReportColumn } from "@/components/report";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import type { BalanceAgingResult, BalanceRow } from "@/lib/reports/balanceAging";

export function BalanceAgingView({ data }: { data: BalanceAgingResult }) {
  const money = useMoneyFormatter();
  const c = (v: number) => money(v, { whole: true });
  const { rows, totals } = data;

  const columns: ReportColumn<BalanceRow>[] = [
    {
      key: "orderno",
      label: "Order #",
      sortable: true,
      render: (r) => (
        <Link href={`/app/sales/orders/${r.id}`} className="text-sh-blue hover:underline">
          {r.orderno}
        </Link>
      ),
    },
    {
      key: "customerName",
      label: "Customer",
      sortable: true,
      render: (r) =>
        r.customerId ? (
          <Link
            href={`/app/sales/customers/${r.customerId}`}
            className="text-sh-blue hover:underline"
          >
            {r.customerName}
          </Link>
        ) : (
          r.customerName
        ),
    },
    { key: "salesperson", label: "Salesperson", sortable: true },
    { key: "orderDate", label: "Order Date", sortable: true, format: (r) => r.orderDate ?? "—" },
    {
      key: "orderTotal",
      label: "Order Total",
      align: "right",
      sortable: true,
      format: (r) => c(r.orderTotal),
      csvFormat: (r) => r.orderTotal,
    },
    {
      key: "totalPaid",
      label: "Paid",
      align: "right",
      sortable: true,
      format: (r) => c(r.totalPaid),
      csvFormat: (r) => r.totalPaid,
    },
    {
      key: "balanceDue",
      label: "Balance Due",
      align: "right",
      sortable: true,
      format: (r) => c(r.balanceDue),
      csvFormat: (r) => r.balanceDue,
    },
    {
      key: "ageDays",
      label: "Age",
      align: "right",
      sortable: true,
      format: (r) => `${r.ageDays}d`,
    },
    { key: "ageBucket", label: "Bucket", sortable: true },
  ];

  return (
    <div className="space-y-6 font-serif">
      <nav className="text-sm text-sh-gray">
        <Link href="/app/reports" className="hover:underline">
          Reports
        </Link>
        <span className="mx-2">/</span>
        <span className="text-sh-black">Balance Due Aging</span>
      </nav>
      <h1 className="text-2xl font-semibold text-sh-navy">Balance Due Aging</h1>
      <p className="text-sm text-sh-gray">
        Unpaid balances on open orders by age. Money sitting on the table that needs collection.
      </p>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Total Balance Due" value={c(totals.totalBalance)} />
        <KpiCard label="Current (0-30d)" value={c(totals.current)} />
        <KpiCard
          label="Overdue (31-90d)"
          value={c(totals.overdue)}
          trend="down"
          positiveIsGood={false}
        />
        <KpiCard
          label="Seriously Overdue (90d+)"
          value={c(totals.serious)}
          trend="down"
          positiveIsGood={false}
        />
      </div>
      <ReportSection
        title={`${totals.total} Orders with Balance Due`}
        description="Sorted by balance due, highest first"
      >
        <ReportTable<BalanceRow>
          columns={columns}
          rows={rows}
          getRowKey={(r) => r.id}
          exportFilename="balance-aging"
          emptyMessage="No unpaid balances"
          pageSize={50}
        />
      </ReportSection>
    </div>
  );
}
