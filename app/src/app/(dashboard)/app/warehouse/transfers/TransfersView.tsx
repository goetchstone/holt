"use client";

// /app/src/app/(dashboard)/app/warehouse/transfers/TransfersView.tsx
//
// Transfers list body (paginated, searchable). App Router port of the legacy
// pages/warehouse/transfers/index.tsx body. Replicates StandardListPage's search
// + pagination inline (without its MainLayout chrome, which the (dashboard)
// layout supplies), reading the shared /api/warehouse/transfers REST endpoint.

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import axios from "axios";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import TableWithFilters from "@/components/table/TableWithFilters";
import { type Column } from "@/components/table/PaginatedTable";

interface TransferRow {
  id: number;
  productName: string;
  productNumber: string;
  quantity: number;
  fromLocation: string;
  fromStockLocation: string | null;
  toLocation: string;
  toStockLocation: string | null;
  status: string;
  requestedBy: string;
  created: string;
}

const STATUS_STYLES: Record<string, string> = {
  DRAFT: "bg-sh-gray/20 text-sh-gray",
  IN_TRANSIT: "bg-blue-100 text-blue-800",
  RECEIVED: "bg-green-100 text-green-800",
  CANCELLED: "bg-red-100 text-red-800",
};

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  IN_TRANSIT: "In Transit",
  RECEIVED: "Received",
  CANCELLED: "Cancelled",
};

function formatLocation(name: string, stockLocation: string | null) {
  if (stockLocation) return `${name} - ${stockLocation}`;
  return name;
}

export function TransfersView() {
  const router = useRouter();

  const [data, setData] = useState<TransferRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await axios.get("/api/warehouse/transfers", {
        params: { page, search, limit: 25 },
      });
      setData(res.data.transfers || []);
      setTotal(res.data.total || 0);
    } catch {
      toast.error("Failed to load transfers");
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSearchChange = (newSearchTerm: string) => {
    setPage(1);
    setSearch(newSearchTerm);
  };

  const columns: Column[] = [
    {
      key: "productName",
      label: "Product",
      accessor: "productName",
      render: (row: TransferRow) => (
        <div>
          <div className="text-sh-black">{row.productName}</div>
          <div className="text-xs text-sh-gray">{row.productNumber}</div>
        </div>
      ),
    },
    {
      key: "fromLocation",
      label: "From",
      accessor: "fromLocation",
      width: "160px",
      render: (row: TransferRow) => (
        <span className="text-sh-gray text-sm">
          {formatLocation(row.fromLocation, row.fromStockLocation)}
        </span>
      ),
    },
    {
      key: "toLocation",
      label: "To",
      accessor: "toLocation",
      width: "160px",
      render: (row: TransferRow) => (
        <span className="text-sh-gray text-sm">
          {formatLocation(row.toLocation, row.toStockLocation)}
        </span>
      ),
    },
    {
      key: "quantity",
      label: "Qty",
      accessor: "quantity",
      width: "60px",
      align: "right" as const,
    },
    {
      key: "status",
      label: "Status",
      accessor: "status",
      width: "100px",
      render: (row: TransferRow) => (
        <span
          className={`text-xs px-2 py-0.5 rounded ${STATUS_STYLES[row.status] || "bg-sh-gray/20 text-sh-gray"}`}
        >
          {STATUS_LABELS[row.status] || row.status}
        </span>
      ),
    },
    {
      key: "created",
      label: "Requested",
      accessor: "created",
      width: "100px",
      render: (row: TransferRow) =>
        row.created ? format(new Date(row.created), "MMM d, yyyy") : "",
    },
  ];

  return (
    <div className="py-2 font-serif text-sh-black">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-semibold text-sh-blue">Transfers</h1>
        <Button size="sm" onClick={() => router.push("/app/warehouse/transfers/new")}>
          New Transfer
        </Button>
      </div>

      <TableWithFilters<TransferRow>
        data={data}
        columns={columns}
        searchFields={[]}
        storageKey="warehouse-transfers-filters"
        total={total}
        page={page}
        onPageChange={setPage}
        loading={loading}
        onRowClick={(row) => router.push(`/app/warehouse/transfers/${row.id}`)}
        onSearchChange={handleSearchChange}
      />
    </div>
  );
}
