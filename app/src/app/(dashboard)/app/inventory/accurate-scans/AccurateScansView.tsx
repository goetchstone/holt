"use client";

// /app/src/app/(dashboard)/app/inventory/accurate-scans/AccurateScansView.tsx
//
// Accurate Scans body (paginated table of correctly-counted items for a
// location). App Router port of the legacy pages/inventory/accurate-scans.tsx
// body, minus MainLayout chrome (supplied by the (dashboard) layout). Reads the
// ?location= / ?reportType= params via useSearchParams and the shared
// /api/inventory/accurate-scans REST endpoint.

import { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import axios from "axios";
import { toast } from "react-toastify";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import PaginatedTable, { type Column } from "@/components/table/PaginatedTable";

interface AccurateRecord {
  productName: string;
  productNumber: string;
  counted: number;
}

const rowsPerPage = 50;

function backHrefFor(reportType: string | null, location: string | null): string {
  return reportType === "apparel"
    ? `/app/inventory/variance-apparel?location=${location}`
    : `/app/inventory/variance-report?location=${location}`;
}

export function AccurateScansView() {
  const searchParams = useSearchParams();
  const location = searchParams?.get("location") ?? null;
  const reportType = searchParams?.get("reportType") ?? null;

  const [records, setRecords] = useState<AccurateRecord[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);

  const fetchRecords = useCallback(async () => {
    if (!location || !reportType) return;
    setLoading(true);
    try {
      const res = await axios.get("/api/inventory/accurate-scans", {
        params: { location, reportType, page: currentPage, limit: rowsPerPage },
      });
      setRecords(res.data.records);
      setTotalCount(res.data.total);
    } catch {
      toast.error(`Failed to load accurate scans for ${location}.`);
    } finally {
      setLoading(false);
    }
  }, [location, reportType, currentPage]);

  useEffect(() => {
    fetchRecords();
  }, [fetchRecords]);

  const columns: Column[] = [
    { key: "productName", label: "Product Name", accessor: "productName" },
    { key: "productNumber", label: "Product #", accessor: "productNumber" },
    {
      key: "counted",
      label: "Quantity Counted",
      accessor: "counted",
      align: "center",
      render: (row: AccurateRecord) => <div className="text-center font-bold">{row.counted}</div>,
    },
  ];

  return (
    <div className="py-2 font-serif">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-sh-blue">Accurate Scans Report</h1>
          <p className="text-sh-gray">
            Showing {totalCount.toLocaleString()} correctly-counted items for {location}.
          </p>
        </div>
        <Link
          href={backHrefFor(reportType, location)}
          className="flex items-center gap-2 text-sh-blue hover:underline"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Variance Report
        </Link>
      </div>

      <PaginatedTable
        data={records}
        columns={columns}
        totalCount={totalCount}
        onPageChange={setCurrentPage}
        currentPage={currentPage}
        loading={loading}
        rowsPerPage={rowsPerPage}
      />
    </div>
  );
}
