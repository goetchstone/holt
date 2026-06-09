"use client";

// /app/src/app/(dashboard)/app/reports/sales-daily/SalesDailyView.tsx
//
// Client view for the daily sales report. First port to use the tRPC CLIENT
// hooks (api.reports.salesDaily.useQuery) reactively as the date-range +
// department filters change — proving the end-to-end client tRPC path with
// zod-validated input. Departments populate from api.reports.departments.

import { useMemo, useState } from "react";
import { endOfDay, format, startOfDay, subDays } from "date-fns";
import PaginatedTable from "@/components/table/PaginatedTable";
import DateRangeFilter from "@/components/form/DateRangeFilter";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { api } from "@/lib/trpc/client";
import type { SalesDailyRow } from "@/lib/reports/salesDaily";

const ROWS_PER_PAGE = 20;

export function SalesDailyView() {
  const money = useMoneyFormatter();
  const [page, setPage] = useState(1);
  const [selectedDepartments, setSelectedDepartments] = useState<string[]>([]);
  const [dateRange, setDateRange] = useState({
    startDate: format(startOfDay(subDays(new Date(), 7)), "yyyy-MM-dd"),
    endDate: format(endOfDay(new Date()), "yyyy-MM-dd"),
  });

  const departmentsQuery = api.reports.departments.useQuery();
  const salesQuery = api.reports.salesDaily.useQuery({
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
    departments: selectedDepartments,
  });

  const rows = useMemo<SalesDailyRow[]>(() => salesQuery.data ?? [], [salesQuery.data]);
  const paginated = rows.slice((page - 1) * ROWS_PER_PAGE, page * ROWS_PER_PAGE);

  const columns = [
    {
      key: "orderDate",
      label: "Date",
      accessor: "orderDate",
      render: (row: SalesDailyRow) => format(new Date(`${row.orderDate}T00:00:00`), "MM/dd/yyyy"),
    },
    { key: "storeLocation", label: "Store", accessor: "storeLocation" },
    {
      key: "totalSales",
      label: "Total Sales",
      accessor: "totalSales",
      align: "right" as const,
      render: (row: SalesDailyRow) => money(row.totalSales),
    },
    {
      key: "transactionCount",
      label: "Line Items",
      accessor: "transactionCount",
      align: "right" as const,
    },
  ];

  return (
    <div className="py-2 font-serif">
      <h1 className="mb-4 text-2xl font-semibold text-sh-blue">Daily Sales Report</h1>
      <div className="mb-4 flex flex-wrap items-end gap-4 rounded-lg bg-sh-linen p-4">
        <DateRangeFilter value={dateRange} onChange={setDateRange} />
        <div className="flex flex-col">
          <label htmlFor="dept-filter" className="mb-1 font-serif text-sh-black">
            Filter by Department
          </label>
          <select
            id="dept-filter"
            multiple
            className="h-24 rounded-lg border border-sh-gray px-3 py-2"
            value={selectedDepartments}
            onChange={(e) =>
              setSelectedDepartments(Array.from(e.target.selectedOptions, (o) => o.value))
            }
          >
            {(departmentsQuery.data ?? []).map((dept) => (
              <option key={dept.id} value={dept.name}>
                {dept.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <PaginatedTable
        data={paginated}
        columns={columns}
        totalCount={rows.length}
        onPageChange={setPage}
        currentPage={page}
        loading={salesQuery.isLoading}
      />
    </div>
  );
}
