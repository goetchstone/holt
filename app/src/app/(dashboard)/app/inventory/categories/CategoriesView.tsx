"use client";

// /app/src/app/(dashboard)/app/inventory/categories/CategoriesView.tsx
//
// Product Categories taxonomy list. App Router port of the legacy
// inventory/categories/index body. Replicates StandardListPage's search +
// pagination inline (the (dashboard) layout supplies the chrome), reading the
// shared /api/categories REST endpoint. Create/edit modal + Delete-All kept.

import { useState, useEffect, useCallback } from "react";
import { Category } from "@prisma/client";
import { toast } from "react-toastify";
import { Pencil, Plus, Trash2 } from "lucide-react";
import TableWithFilters from "@/components/table/TableWithFilters";
import { type Column } from "@/components/table/PaginatedTable";
import CategoryModal from "@/components/modals/CategoryModal";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";

type CategoryWithRelations = Category & {
  departmentName?: string;
  labelTemplateName?: string;
};

function yesNo(value: boolean): string {
  return value ? "Yes" : "No";
}

export function CategoriesView() {
  const [data, setData] = useState<CategoryWithRelations[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<CategoryWithRelations | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/categories?page=${page}&limit=10&search=${encodeURIComponent(search)}`,
      );
      const json = await res.json();
      setData(json.categories);
      setTotal(json.total);
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to load categories"));
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

  const handleCategorySaved = () => {
    setSelectedCategory(null);
    setRefreshTrigger(Date.now());
  };

  const handleDeleteAll = async () => {
    const confirmed = confirm(
      "Are you absolutely sure you want to delete ALL categories? This action cannot be undone and will affect products linked to them.",
    );
    if (!confirmed) return;

    try {
      const res = await fetch("/api/categories/delete-all", { method: "DELETE" });
      if (res.ok) {
        const result = await res.json().catch(() => null);
        toast.success(result?.message || "All categories deleted successfully");
        setRefreshTrigger(Date.now());
      } else {
        const errorData = await res.json().catch(() => null);
        toast.error(errorData?.error || errorData?.message || "Failed to delete all categories");
      }
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to delete all categories"));
    }
  };

  const columns: Column[] = [
    { key: "name", label: "Category Name", accessor: "name", width: "200px" },
    { key: "departmentName", label: "Department", accessor: "departmentName", width: "150px" },
    {
      key: "trackInventory",
      label: "Track Inventory",
      accessor: "trackInventory",
      width: "120px",
      render: (row: CategoryWithRelations) => yesNo(row.trackInventory),
    },
    {
      key: "labelTemplateName",
      label: "Label Template",
      accessor: "labelTemplateName",
      width: "150px",
    },
    {
      key: "actions",
      label: "Actions",
      accessor: "id",
      width: "100px",
      render: (row: CategoryWithRelations) => (
        <div className="flex space-x-2">
          <Button
            variant="outline"
            onClick={(e) => {
              e.stopPropagation();
              setSelectedCategory(row);
            }}
          >
            Edit <Pencil className="w-4 h-4 ml-2" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="py-2 font-serif text-sh-black">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-semibold text-sh-blue">Product Categories</h1>
        <div className="flex space-x-2">
          <Button variant="secondary" onClick={handleDeleteAll}>
            Delete All <Trash2 className="w-4 h-4 ml-2" />
          </Button>
          <Button
            variant="primary"
            onClick={() => setSelectedCategory({} as CategoryWithRelations)}
          >
            + Add New <Plus className="w-4 h-4 ml-2" />
          </Button>
        </div>
      </div>

      <TableWithFilters<CategoryWithRelations>
        data={data}
        columns={columns}
        searchFields={[]}
        storageKey="categories"
        total={total}
        page={page}
        onPageChange={setPage}
        loading={loading}
        onRowClick={(row) => setSelectedCategory(row)}
        onSearchChange={handleSearchChange}
      />

      {selectedCategory && (
        <CategoryModal
          category={selectedCategory}
          onClose={() => setSelectedCategory(null)}
          onRefresh={handleCategorySaved}
        />
      )}
    </div>
  );
}
