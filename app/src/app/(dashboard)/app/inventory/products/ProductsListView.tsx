"use client";

// /app/src/app/(dashboard)/app/inventory/products/ProductsListView.tsx
//
// Products list body. App Router port of the legacy inventory/products/index
// body. Replicates StandardListPage's search + pagination inline (without its
// MainLayout chrome, which the (dashboard) layout supplies), reading the shared
// /api/products REST endpoint. Edit modal + "Add New" preserved.

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Product } from "@prisma/client";
import { toast } from "react-toastify";
import { Pencil, Plus } from "lucide-react";
import TableWithFilters from "@/components/table/TableWithFilters";
import { type Column } from "@/components/table/PaginatedTable";
import ProductEditModal from "@/components/modals/ProductEditModal";
import { Button } from "@/components/ui/button";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";

type ProductWithRelations = Product & {
  vendorName?: string;
  categoryName?: string;
  departmentName?: string;
  typeName?: string;
};

export function ProductsListView() {
  const router = useRouter();
  const fmt = useMoneyFormatter();

  const [data, setData] = useState<ProductWithRelations[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<ProductWithRelations | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/products?page=${page}&limit=10&search=${encodeURIComponent(search)}`,
      );
      const json = await res.json();
      setData(json.products);
      setTotal(json.total);
    } catch {
      toast.error("Failed to load products");
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => {
    loadData();
  }, [loadData, refreshTrigger]);

  const handleSearchChange = (newSearchTerm: string) => {
    setPage(1);
    setSearch(newSearchTerm);
  };

  const handleProductSaved = () => {
    setSelectedProduct(null);
    setRefreshTrigger(Date.now());
  };

  const columns: Column[] = [
    { key: "productNumber", label: "Product #", accessor: "productNumber", width: "130px" },
    { key: "name", label: "Product Name", accessor: "name" },
    { key: "vendorName", label: "Vendor", accessor: "vendorName", width: "130px" },
    { key: "categoryName", label: "Category", accessor: "categoryName", width: "120px" },
    {
      key: "baseCost",
      label: "Cost",
      accessor: "baseCost",
      width: "90px",
      align: "right" as const,
      render: (row: ProductWithRelations) => (row.baseCost ? fmt(Number(row.baseCost)) : ""),
    },
    {
      key: "baseRetail",
      label: "Retail",
      accessor: "baseRetail",
      width: "90px",
      align: "right" as const,
      render: (row: ProductWithRelations) => (row.baseRetail ? fmt(Number(row.baseRetail)) : ""),
    },
    {
      key: "actions",
      label: "",
      accessor: "id",
      width: "60px",
      render: (row: ProductWithRelations) => (
        <Button
          variant="outline"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            setSelectedProduct(row);
          }}
        >
          <Pencil className="w-3.5 h-3.5" />
        </Button>
      ),
    },
  ];

  return (
    <div className="py-2 font-serif text-sh-black">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-semibold text-sh-blue">All Products</h1>
        <Button variant="primary" onClick={() => router.push("/app/inventory/products/new")}>
          Add New <Plus className="w-4 h-4 ml-2" />
        </Button>
      </div>

      <TableWithFilters<ProductWithRelations>
        data={data}
        columns={columns}
        searchFields={[]}
        storageKey="products"
        total={total}
        page={page}
        onPageChange={setPage}
        loading={loading}
        onRowClick={(row) => router.push(`/app/inventory/products/${row.id}`)}
        onSearchChange={handleSearchChange}
      />

      {selectedProduct && (
        <ProductEditModal
          product={selectedProduct}
          onClose={() => setSelectedProduct(null)}
          onSave={handleProductSaved}
        />
      )}
    </div>
  );
}
