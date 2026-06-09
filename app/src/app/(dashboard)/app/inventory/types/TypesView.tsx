"use client";

// /app/src/app/(dashboard)/app/inventory/types/TypesView.tsx
//
// Product Types taxonomy list. App Router port of the legacy
// inventory/types/index body. Replicates StandardListPage's search +
// pagination inline (the (dashboard) layout supplies the chrome), reading the
// shared /api/types REST endpoint. Create/edit modal + row-delete kept.

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Type } from "@prisma/client";
import { toast } from "react-toastify";
import { Pencil, Plus, Trash2 } from "lucide-react";
import TableWithFilters from "@/components/table/TableWithFilters";
import { type Column } from "@/components/table/PaginatedTable";
import TypeModal from "@/components/modals/TypeModal";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";

type TypeWithCategory = Type & {
  categoryName?: string;
};

export function TypesView() {
  const router = useRouter();

  const [data, setData] = useState<TypeWithCategory[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [selectedType, setSelectedType] = useState<TypeWithCategory | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/types?page=${page}&limit=10&search=${encodeURIComponent(search)}`,
      );
      const json = await res.json();
      setData(json.types);
      setTotal(json.total);
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to load types"));
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

  const handleSavedOrDeleted = () => {
    setSelectedType(null);
    setRefreshTrigger(Date.now());
  };

  const handleDelete = async (type: TypeWithCategory) => {
    const confirmed = confirm(
      `Are you sure you want to delete type "${type.name}"? This cannot be undone.`,
    );
    if (!confirmed) return;

    try {
      const res = await fetch(`/api/types/${type.id}`, { method: "DELETE" });
      if (res.ok) {
        handleSavedOrDeleted();
      } else {
        const errorData = await res.json().catch(() => null);
        toast.error(errorData?.error || errorData?.message || "Failed to delete type");
      }
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to delete type"));
    }
  };

  const columns: Column[] = [
    { key: "name", label: "Name", accessor: "name", width: "200px" },
    { key: "categoryName", label: "Category", accessor: "categoryName", width: "200px" },
    {
      key: "actions",
      label: "Actions",
      accessor: "id",
      width: "200px",
      render: (row: TypeWithCategory) => (
        <div className="flex space-x-2">
          <Button
            variant="outline"
            onClick={(e) => {
              e.stopPropagation();
              setSelectedType(row);
            }}
          >
            Edit <Pencil className="w-4 h-4 ml-2" />
          </Button>
          <Button
            variant="secondary"
            onClick={(e) => {
              e.stopPropagation();
              handleDelete(row);
            }}
          >
            Delete <Trash2 className="w-4 h-4 ml-2" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="py-2 font-serif text-sh-black">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-semibold text-sh-blue">Product Types</h1>
        <Button variant="primary" onClick={() => setSelectedType({} as TypeWithCategory)}>
          + Add New <Plus className="w-4 h-4 ml-2" />
        </Button>
      </div>

      <TableWithFilters<TypeWithCategory>
        data={data}
        columns={columns}
        searchFields={[]}
        storageKey="types"
        total={total}
        page={page}
        onPageChange={setPage}
        loading={loading}
        onRowClick={(row) => router.push(`/app/inventory/types/${row.id}`)}
        onSearchChange={handleSearchChange}
      />

      {selectedType && (
        <TypeModal
          type={selectedType.id ? selectedType : null}
          onClose={() => setSelectedType(null)}
          onRefresh={handleSavedOrDeleted}
        />
      )}
    </div>
  );
}
