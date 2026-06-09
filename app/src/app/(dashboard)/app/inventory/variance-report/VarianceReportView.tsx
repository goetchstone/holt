"use client";

// /app/src/app/(dashboard)/app/inventory/variance-report/VarianceReportView.tsx
//
// General Variance Report body (location picker + summary cards + paginated
// reconcile table + CSV export). App Router port of the legacy
// pages/inventory/variance-report.tsx body, minus MainLayout chrome (supplied by
// the (dashboard) layout). Reads the ?location= param via useSearchParams and
// the shared /api/inventory/* REST endpoints. Shared variance-table logic lives
// in ../_variance/varianceTable.

import { useState, useEffect, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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

export function VarianceReportView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryLocation = searchParams?.get("location") ?? null;

  const [location, setLocation] = useState("");
  const [inventoryLocations, setInventoryLocations] = useState<string[]>([]);
  const [reportData, setReportData] = useState<VarianceRecord[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [accurateCount, setAccurateCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [initialLoad, setInitialLoad] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);
  const [sortConfig, setSortConfig] = useState<SortConfig>({ key: "variance", direction: "desc" });

  const loadLocations = useCallback(async () => {
    try {
      const res = await axios.get<string[]>("/api/inventory/locations");
      const availableLocations = res.data;
      setInventoryLocations(availableLocations);

      if (queryLocation && availableLocations.includes(queryLocation)) {
        setLocation(queryLocation);
      } else {
        const defaultLoc =
          availableLocations.find((loc) => loc !== "Warehouse") || availableLocations[0] || "";
        setLocation(defaultLoc);
      }
      setInitialLoad(false);
    } catch {
      toast.error("Could not load inventory locations.");
      setInitialLoad(false);
    }
  }, [queryLocation]);

  useEffect(() => {
    loadLocations();
  }, [loadLocations]);

  const fetchReport = useCallback(() => {
    if (!location) return;
    setLoading(true);
    const params = {
      location,
      reportType: "general",
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
      .catch(() => toast.error(`Failed to load variance report for ${location}.`))
      .finally(() => setLoading(false));
  }, [location, currentPage, sortConfig]);

  useEffect(() => {
    if (!initialLoad) {
      fetchReport();
    }
  }, [initialLoad, fetchReport]);

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
      `/api/inventory/export-variance?location=${location}&reportType=general&varianceType=${varianceType}`,
    );
  };

  const columns = buildVarianceColumns({
    productHref: (row) => `/app/inventory/product-variance/${row.externalId}?location=${location}`,
    onReconcile: handleReconcile,
  });

  let body: React.ReactNode;
  if (initialLoad) {
    body = <p>Loading...</p>;
  } else if (location) {
    body = (
      <>
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
              href={`/app/inventory/accurate-scans?location=${location}&reportType=general`}
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
      </>
    );
  } else {
    body = (
      <div className="text-center p-8 border rounded-lg bg-gray-50">
        <h3 className="text-lg font-semibold text-sh-black">No General Locations Found</h3>
        <p className="text-sh-gray">
          There are currently no locations with scannable inventory besides the Warehouse.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto mt-8 font-serif">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-semibold text-sh-blue">General Variance Report</h1>
        <div className="flex items-center space-x-2">
          {location && (
            <Link
              href={`/app/inventory/reconciled-items?location=${location}&reportType=general`}
              className="flex items-center gap-2 text-sh-blue hover:underline"
            >
              <RotateCcw className="w-4 h-4" /> View/Undo Reconciled
            </Link>
          )}
          <label htmlFor="variance-location" className="sr-only">
            Location
          </label>
          <select
            id="variance-location"
            value={location}
            onChange={(e) => {
              router.push(`/app/inventory/variance-report?location=${e.target.value}`);
            }}
            className="border rounded p-2"
            disabled={inventoryLocations.length === 0}
          >
            {inventoryLocations.length > 0 ? (
              inventoryLocations.map((loc) => (
                <option key={loc} value={loc}>
                  {loc}
                </option>
              ))
            ) : (
              <option>No locations to report</option>
            )}
          </select>
          <Button
            onClick={() => handleExport("additions")}
            disabled={!location}
            variant="secondary"
          >
            Export Additions (+)
          </Button>
          <Button onClick={() => handleExport("missing")} disabled={!location} variant="secondary">
            Export Missing (-)
          </Button>
          <Button onClick={() => handleExport("all")} disabled={!location}>
            <Download className="w-4 h-4 mr-2" />
            Export All
          </Button>
        </div>
      </div>

      {body}
    </div>
  );
}
