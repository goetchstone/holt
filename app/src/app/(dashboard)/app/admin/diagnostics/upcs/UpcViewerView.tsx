"use client";

// /app/src/app/(dashboard)/app/admin/diagnostics/upcs/UpcViewerView.tsx
//
// UPC / Barcode Viewer body. App Router port of the legacy
// admin/diagnostics/upcs body (minus MainLayout chrome). Pages through imported
// barcodes via the shared /api/diagnostics/upcs REST endpoint so an admin can
// verify barcodes are linked to the right products.

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import PaginatedTable, { type Column } from "@/components/table/PaginatedTable";

interface FlatUpcRecord {
  id: number;
  upc: string;
  productName: string;
  productNumber: string;
}

const COLUMNS: Column[] = [
  { key: "upc", label: "Barcode (UPC)", accessor: "upc" },
  { key: "productName", label: "Product Name", accessor: "productName" },
  { key: "productNumber", label: "Product #", accessor: "productNumber" },
];

export function UpcViewerView() {
  const [data, setData] = useState<FlatUpcRecord[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(true);

  const loadUpcs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await axios.get(`/api/diagnostics/upcs?page=${currentPage}`);
      setData(res.data.upcs);
      setTotalCount(res.data.totalCount);
    } catch {
      toast.error("Failed to load UPC data.");
    } finally {
      setLoading(false);
    }
  }, [currentPage]);

  useEffect(() => {
    loadUpcs();
  }, [loadUpcs]);

  return (
    <div className="py-2 font-serif">
      <h1 className="text-2xl font-semibold text-sh-blue mb-4">UPC / Barcode Viewer</h1>
      <p className="mb-4 text-sh-gray">
        Use this tool to verify that barcodes have been imported correctly and are linked to the
        right products.
      </p>
      <PaginatedTable
        data={data}
        columns={COLUMNS}
        totalCount={totalCount}
        currentPage={currentPage}
        onPageChange={setCurrentPage}
        loading={loading}
      />
    </div>
  );
}
