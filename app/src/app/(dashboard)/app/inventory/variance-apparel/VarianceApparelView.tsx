"use client";

// /app/src/app/(dashboard)/app/inventory/variance-apparel/VarianceApparelView.tsx
//
// Apparel Variance Report body (Warehouse-only summary cards + paginated
// reconcile table + CSV export). App Router port of the legacy
// pages/inventory/variance-apparel.tsx body, minus MainLayout chrome (supplied
// by the (dashboard) layout). Location is fixed to "Warehouse". Reads the shared
// /api/inventory/* REST endpoints. Shared variance-table logic lives in
// ../_variance/varianceTable.

import { useState, useEffect, useCallback } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import Link from "next/link";
import { Download, RotateCcw } from "lucide-react";
import PaginatedTable from "@/components/table/PaginatedTable";
import { Button } from "@/components/ui/button";
import {
  type VarianceRecord,
  type SortConfig,
  type ReconcileAction,
  buildVarianceColumns,
  reconcileVariance,
} from "../_variance/varianceTable";

const rowsPerPage = 8;
const location = "Warehouse";

export function VarianceApparelView() {
  const [reportData, setReportData] = useState<VarianceRecord[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [accurateCount, setAccurateCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);
  const [sortConfig, setSortConfig] = useState<SortConfig>({ key: "variance", direction: "desc" });

  const fetchReport = useCallback(() => {
    setLoading(true);
    const params = {
      location,
      reportType: "apparel",
      page: currentPage,
      limit: rowsPerPage,
      sortBy: sortConfig.key,
      sortOrder: sortConfig.direction,
    };
    axios
      .get(`/api/inventory/variance-report`, { params })
      .then((res) => {
        setReportData(res.data.records);
        setTotalCount(res.data.total);
        setAccurateCount(res.data.accurateCount);
      })
      .catch(() => toast.error(`Failed to load apparel variance report.`))
      .finally(() => setLoading(false));
  }, [currentPage, sortConfig]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  const handleSort = (key: string) => {
    let direction: "asc" | "desc" = "asc";
    if (sortConfig.key === key && sortConfig.direction === "asc") {
      direction = "desc";
    }
    setCurrentPage(1);
    setSortConfig({ key, direction });
  };

  const handleReconcile = (item: VarianceRecord, action: ReconcileAction) =>
    reconcileVariance({ item, location, action, onDone: fetchReport });

  const handleExport = (varianceType: "additions" | "missing" | "all") => {
    globalThis.open(
      `/api/inventory/export-variance?location=${location}&reportType=apparel&varianceType=${varianceType}`,
    );
  };

  const columns = buildVarianceColumns({
    productHref: (row) =>
      `/app/inventory/product-variance/${row.externalId}?location=${location}&returnUrl=/inventory/variance-apparel`,
    onReconcile: handleReconcile,
  });

  return (
    <div className="max-w-6xl mx-auto mt-8 font-serif">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-semibold text-sh-blue">Apparel Variance Report</h1>
        <div className="flex items-center space-x-2">
          <Link
            href={`/app/inventory/reconciled-items?location=${location}&reportType=apparel`}
            className="flex items-center gap-2 text-sh-blue hover:underline"
          >
            <RotateCcw className="w-4 h-4" />
            View/Undo Reconciled
          </Link>
          <Button onClick={() => handleExport("additions")} variant="secondary">
            Export Additions (+)
          </Button>
          <Button onClick={() => handleExport("missing")} variant="secondary">
            Export Missing (-)
          </Button>
          <Button onClick={() => handleExport("all")}>
            <Download className="w-4 h-4 mr-2" />
            Export All
          </Button>
        </div>
      </div>

      <div className="p-4 bg-sh-linen rounded-lg mb-4 grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <h3 className="text-sm text-sh-gray">Location</h3>
          <p className="text-lg font-bold text-sh-blue">{location}</p>
        </div>
        <div>
          <h3 className="text-sm text-sh-gray">Items with Variances</h3>
          <p className="text-lg font-bold text-sh-blue">{totalCount.toLocaleString()}</p>
        </div>
        <div>
          <h3 className="text-sm text-sh-gray">Accurate Items</h3>
          <Link
            href={`/app/inventory/accurate-scans?location=${location}&reportType=apparel`}
            className="hover:underline"
          >
            <p className="text-lg font-bold text-sh-blue">{accurateCount.toLocaleString()}</p>
          </Link>
        </div>
      </div>

      <PaginatedTable
        data={reportData}
        columns={columns}
        totalCount={totalCount}
        onPageChange={setCurrentPage}
        currentPage={currentPage}
        loading={loading}
        rowsPerPage={rowsPerPage}
        onSort={handleSort}
        sortConfig={sortConfig}
      />
    </div>
  );
}
