"use client";

// /app/src/app/(dashboard)/app/purchasing/receiving/ReceivingListView.tsx
//
// Receiving Records list. App Router port; reads the shared
// /api/purchasing/receiving REST endpoint, which stays REST. Replicates
// StandardListPage's search + pagination without its MainLayout chrome, since the
// (dashboard) layout supplies chrome.

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import axios from "axios";
import { toast } from "react-toastify";
import TableWithFilters from "@/components/table/TableWithFilters";
import { type Column } from "@/components/table/PaginatedTable";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";

interface ReceivingRow {
  id: number;
  externalPorNo?: string;
  poNumber: string;
  vendorName: string;
  partNo?: string;
  productName?: string;
  quantityReceived: number;
  receivedDate: string;
  destinationLocation?: string;
  lineCost: number | null;
  purchaseOrderId: number;
}

export function ReceivingListView() {
  const router = useRouter();
  const formatCurrency = useMoneyFormatter();
  const [data, setData] = useState<ReceivingRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await axios.get("/api/purchasing/receiving", {
        params: { page, search, limit: 10 },
      });
      setData(res.data.records || []);
      setTotal(res.data.total || 0);
    } catch {
      toast.error("Failed to load receiving records");
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
      key: "receivedDate",
      label: "Date",
      accessor: "receivedDate",
      width: "130px",
      render: (row: ReceivingRow) =>
        row.receivedDate ? format(new Date(row.receivedDate), "PPP") : "N/A",
    },
    { key: "poNumber", label: "PO #", accessor: "poNumber", width: "140px" },
    { key: "vendorName", label: "Vendor", accessor: "vendorName" },
    { key: "partNo", label: "Part #", accessor: "partNo", width: "130px" },
    {
      key: "quantityReceived",
      label: "Qty",
      accessor: "quantityReceived",
      width: "60px",
      align: "right" as const,
    },
    {
      key: "lineCost",
      label: "Cost",
      accessor: "lineCost",
      width: "90px",
      align: "right" as const,
      render: (row: ReceivingRow) => (row.lineCost != null ? formatCurrency(row.lineCost) : "—"),
    },
    {
      key: "destinationLocation",
      label: "Destination",
      accessor: "destinationLocation",
      width: "120px",
      render: (row: ReceivingRow) => row.destinationLocation || "—",
    },
  ];

  return (
    <div className="py-2 font-serif text-sh-black">
      <h1 className="mb-4 text-2xl font-semibold text-sh-blue">Receiving Records</h1>
      <TableWithFilters<ReceivingRow>
        data={data}
        columns={columns}
        searchFields={[]}
        storageKey="receiving-filters"
        total={total}
        page={page}
        onPageChange={setPage}
        loading={loading}
        onRowClick={(row) => router.push(`/app/purchasing/orders/${row.purchaseOrderId}`)}
        onSearchChange={handleSearchChange}
      />
    </div>
  );
}
