"use client";

// /app/src/app/(dashboard)/app/reports/factsalesday/FactSalesDayView.tsx
//
// Client view for the daily sales summary. Receives server-fetched rows and
// renders a paginated table. Currency via useMoneyFormatter (tenant locale).

import { useState } from "react";
import PaginatedTable from "@/components/table/PaginatedTable";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import type { FactSalesDayRow } from "@/lib/reports/factSalesDay";

const ROWS_PER_PAGE = 20;

export function FactSalesDayView({ rows }: { rows: FactSalesDayRow[] }) {
  const money = useMoneyFormatter();
  const [page, setPage] = useState(1);

  const columns = [
    { key: "date", label: "Date", accessor: "date", width: "150px" },
    { key: "department", label: "Department", accessor: "department", width: "200px" },
    {
      key: "totalSales",
      label: "Total Sales",
      accessor: "totalSales",
      width: "150px",
      align: "right" as const,
      render: (row: FactSalesDayRow) => money(row.totalSales),
    },
    {
      key: "numTransactions",
      label: "Transactions",
      accessor: "numTransactions",
      width: "150px",
      align: "right" as const,
    },
    {
      key: "avgSale",
      label: "Avg Sale",
      accessor: "avgSale",
      width: "150px",
      align: "right" as const,
      render: (row: FactSalesDayRow) => money(row.avgSale),
    },
  ];

  const paginated = rows.slice((page - 1) * ROWS_PER_PAGE, page * ROWS_PER_PAGE);

  return (
    <div className="py-2 font-serif">
      <h1 className="mb-4 text-2xl font-semibold text-sh-blue">Daily Sales Summary</h1>
      <PaginatedTable
        data={paginated}
        columns={columns}
        totalCount={rows.length}
        onPageChange={setPage}
        currentPage={page}
      />
    </div>
  );
}
