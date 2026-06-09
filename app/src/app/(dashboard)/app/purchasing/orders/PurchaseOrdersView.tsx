"use client";

// /app/src/app/(dashboard)/app/purchasing/orders/PurchaseOrdersView.tsx
//
// Purchase Orders list (also Vendor Returns via ?filter=returns). App Router
// port; reads the shared /api/purchasing/orders REST endpoint, which stays REST.
// Replicates StandardListPage's search + pagination without its MainLayout
// chrome, since the (dashboard) layout supplies chrome.

import { useState, useEffect, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { format } from "date-fns";
import axios from "axios";
import { toast } from "react-toastify";
import TableWithFilters from "@/components/table/TableWithFilters";
import { type Column } from "@/components/table/PaginatedTable";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";

interface PurchaseOrderRow {
  id: number;
  poNumber: string;
  vendorName: string;
  orderDate: string;
  expectedDelivery?: string;
  status: string;
  isReturn: boolean;
  lineItemCount: number;
  totalCost: number;
  receivedItemCount: number;
}

const STATUS_STYLES: Record<string, string> = {
  DRAFT: "bg-sh-gray/20 text-sh-gray",
  SUBMITTED: "bg-blue-100 text-blue-800",
  CONFIRMED: "bg-yellow-100 text-yellow-800",
  RECEIVED_PARTIAL: "bg-orange-100 text-orange-800",
  RECEIVED_FULL: "bg-green-100 text-green-800",
  SHORT_CLOSED: "bg-purple-100 text-purple-800",
  CANCELLED: "bg-red-100 text-red-800",
};

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Submitted",
  CONFIRMED: "Confirmed",
  RECEIVED_PARTIAL: "Partial",
  RECEIVED_FULL: "Received",
  SHORT_CLOSED: "Short Closed",
  CANCELLED: "Cancelled",
};

export function PurchaseOrdersView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const formatCurrency = useMoneyFormatter();

  const isReturnView = searchParams?.get("filter") === "returns";

  const [data, setData] = useState<PurchaseOrderRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await axios.get("/api/purchasing/orders", {
        params: { page, search, limit: 10, ...(isReturnView ? { isReturn: "true" } : {}) },
      });
      setData(res.data.orders || []);
      setTotal(res.data.total || 0);
    } catch {
      toast.error("Failed to load purchase orders");
    } finally {
      setLoading(false);
    }
  }, [page, search, isReturnView]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSearchChange = (newSearchTerm: string) => {
    setPage(1);
    setSearch(newSearchTerm);
  };

  const columns: Column[] = [
    { key: "poNumber", label: "PO #", accessor: "poNumber", width: "140px" },
    { key: "vendorName", label: "Vendor", accessor: "vendorName" },
    {
      key: "orderDate",
      label: "Order Date",
      accessor: "orderDate",
      width: "130px",
      render: (row: PurchaseOrderRow) =>
        row.orderDate ? format(new Date(row.orderDate), "PPP") : "N/A",
    },
    {
      key: "status",
      label: "Status",
      accessor: "status",
      width: "110px",
      render: (row: PurchaseOrderRow) => (
        <span className="flex items-center gap-1">
          {row.isReturn && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-red-100 text-red-800">Return</span>
          )}
          <span
            className={`text-xs px-2 py-0.5 rounded ${STATUS_STYLES[row.status] || "bg-sh-gray/20 text-sh-gray"}`}
          >
            {STATUS_LABELS[row.status] || row.status}
          </span>
        </span>
      ),
    },
    {
      key: "lineItemCount",
      label: "Items",
      accessor: "lineItemCount",
      width: "70px",
      align: "right" as const,
      render: (row: PurchaseOrderRow) => (
        <span>
          {row.receivedItemCount}/{row.lineItemCount}
        </span>
      ),
    },
    {
      key: "totalCost",
      label: "Total Cost",
      accessor: "totalCost",
      width: "110px",
      align: "right" as const,
      render: (row: PurchaseOrderRow) => (row.totalCost ? formatCurrency(row.totalCost) : "$0.00"),
    },
  ];

  return (
    <div className="py-2 font-serif text-sh-black">
      <h1 className="mb-4 text-2xl font-semibold text-sh-blue">
        {isReturnView ? "Vendor Returns" : "Purchase Orders"}
      </h1>
      <TableWithFilters<PurchaseOrderRow>
        data={data}
        columns={columns}
        searchFields={[]}
        storageKey="purchase-orders-filters"
        total={total}
        page={page}
        onPageChange={setPage}
        loading={loading}
        onRowClick={(row) => router.push(`/app/purchasing/orders/${row.id}`)}
        onSearchChange={handleSearchChange}
      />
    </div>
  );
}
