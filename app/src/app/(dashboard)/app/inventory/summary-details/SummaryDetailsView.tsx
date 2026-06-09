"use client";

// /app/src/app/(dashboard)/app/inventory/summary-details/SummaryDetailsView.tsx
//
// Inventory Summary Details body (sortable expected/counted/variance table for
// one group, e.g. a vendor or department). App Router port of the legacy
// pages/inventory/summary-details.tsx body, minus MainLayout chrome (supplied by
// the (dashboard) layout). Reads ?groupType= / ?groupName= via useSearchParams
// and the shared /api/inventory/summary-details REST endpoint.

import { useState, useEffect, useMemo, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import axios from "axios";
import { toast } from "react-toastify";
import Link from "next/link";
import { ArrowLeft, ArrowUpDown } from "lucide-react";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";

interface ReportRow {
  productId: number;
  externalId: number;
  name: string;
  productNumber: string;
  expectedQty: number;
  countedQty: number;
  varianceQty: number;
  expectedCost: number;
  countedCost: number;
  varianceCost: number;
}

type SortConfig = {
  key: keyof ReportRow;
  direction: "asc" | "desc";
};

interface HeaderConfig {
  key: keyof ReportRow;
  label: string;
  isNumeric?: boolean;
  width?: string;
}

const HEADERS: HeaderConfig[] = [
  { key: "name", label: "Product Name", width: "250px" },
  { key: "productNumber", label: "Product #", width: "120px" },
  { key: "expectedQty", label: "Expected Qty", isNumeric: true, width: "100px" },
  { key: "countedQty", label: "Counted Qty", isNumeric: true, width: "100px" },
  { key: "varianceQty", label: "Variance Qty", isNumeric: true, width: "100px" },
  { key: "expectedCost", label: "Expected Cost", isNumeric: true, width: "150px" },
  { key: "countedCost", label: "Counted Cost", isNumeric: true, width: "150px" },
  { key: "varianceCost", label: "Variance Cost", isNumeric: true, width: "150px" },
];

function varianceClass(value: number): string {
  if (value < 0) return "text-red-600 font-bold";
  if (value > 0) return "text-green-600 font-bold";
  return "";
}

export function SummaryDetailsView() {
  const searchParams = useSearchParams();
  const groupType = searchParams?.get("groupType") ?? null;
  const groupName = searchParams?.get("groupName") ?? null;
  const fmt = useMoneyFormatter();

  const [report, setReport] = useState<ReportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortConfig, setSortConfig] = useState<SortConfig>({
    key: "varianceCost",
    direction: "asc",
  });

  const fetchDetails = useCallback(async () => {
    if (!groupType || !groupName) return;
    setLoading(true);
    try {
      const res = await axios.get(`/api/inventory/summary-details`, {
        params: { groupType, groupName },
      });
      setReport(res.data);
    } catch {
      toast.error("Failed to load details.");
    } finally {
      setLoading(false);
    }
  }, [groupType, groupName]);

  useEffect(() => {
    fetchDetails();
  }, [fetchDetails]);

  const sortedData = useMemo(() => {
    const sortableItems = [...report];
    sortableItems.sort((a, b) => {
      if (a[sortConfig.key] < b[sortConfig.key]) {
        return sortConfig.direction === "asc" ? -1 : 1;
      }
      if (a[sortConfig.key] > b[sortConfig.key]) {
        return sortConfig.direction === "asc" ? 1 : -1;
      }
      return 0;
    });
    return sortableItems;
  }, [report, sortConfig]);

  const requestSort = (key: keyof ReportRow) => {
    let direction: "asc" | "desc" = "asc";
    if (sortConfig.key === key && sortConfig.direction === "asc") {
      direction = "desc";
    }
    setSortConfig({ key, direction });
  };

  return (
    <div className="max-w-6xl mx-auto mt-8 font-serif">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-sh-blue">Inventory Details</h1>
          <p className="text-sh-gray">
            Showing all items for {groupType}: {groupName}
          </p>
        </div>
        <Link
          href="/app/inventory/hub"
          className="flex items-center gap-2 text-sh-blue hover:underline"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Inventory Hub
        </Link>
      </div>

      {loading ? (
        <p>Loading details...</p>
      ) : (
        <div className="border border-sh-gray rounded-lg overflow-hidden shadow-sm">
          <table className="min-w-full text-left text-sm whitespace-nowrap table-fixed w-full">
            <thead className="bg-sh-linen text-sh-black">
              <tr>
                {HEADERS.map(({ key, label, isNumeric, width }) => (
                  <th
                    key={key}
                    className={`p-2 border-b border-sh-gray ${isNumeric ? "text-right" : ""}`}
                    style={{ width }}
                  >
                    <button
                      type="button"
                      onClick={() => requestSort(key)}
                      className="flex items-center gap-1"
                    >
                      {label} <ArrowUpDown className="w-3 h-3 text-gray-400" />
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedData.map((item) => (
                <tr key={item.productId} className="odd:bg-white even:bg-sh-stripe">
                  <td
                    className="p-2 border-b border-sh-gray font-semibold"
                    style={{ width: "250px" }}
                  >
                    <Link
                      href={`/app/inventory/product-variance/${item.externalId}?location=${groupName}`}
                      className="hover:underline text-sh-blue"
                    >
                      <div className="truncate" title={item.name}>
                        {item.name}
                      </div>
                    </Link>
                  </td>
                  <td className="p-2 border-b border-sh-gray" style={{ width: "120px" }}>
                    {item.productNumber}
                  </td>
                  <td className="p-2 border-b border-sh-gray text-right" style={{ width: "100px" }}>
                    {item.expectedQty.toLocaleString()}
                  </td>
                  <td className="p-2 border-b border-sh-gray text-right" style={{ width: "100px" }}>
                    {item.countedQty.toLocaleString()}
                  </td>
                  <td
                    className={`p-2 border-b border-sh-gray text-right font-bold ${varianceClass(item.varianceQty)}`}
                    style={{ width: "100px" }}
                  >
                    {item.varianceQty.toLocaleString()}
                  </td>
                  <td className="p-2 border-b border-sh-gray text-right" style={{ width: "150px" }}>
                    {fmt(item.expectedCost)}
                  </td>
                  <td className="p-2 border-b border-sh-gray text-right" style={{ width: "150px" }}>
                    {fmt(item.countedCost)}
                  </td>
                  <td
                    className={`p-2 border-b border-sh-gray text-right font-bold ${varianceClass(item.varianceCost)}`}
                    style={{ width: "150px" }}
                  >
                    {fmt(item.varianceCost)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
