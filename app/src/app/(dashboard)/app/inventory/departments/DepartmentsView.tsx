"use client";

// /app/src/app/(dashboard)/app/inventory/departments/DepartmentsView.tsx
//
// Departments taxonomy list. App Router port of the legacy
// inventory/departments/index body. Replicates StandardListPage's search +
// pagination inline (the (dashboard) layout supplies the chrome), reading the
// shared /api/departments REST endpoint. Create/edit modal + row-delete kept.

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Department } from "@prisma/client";
import { toast } from "react-toastify";
import { Pencil, Plus, Trash2 } from "lucide-react";
import TableWithFilters from "@/components/table/TableWithFilters";
import { type Column } from "@/components/table/PaginatedTable";
import DepartmentModal from "@/components/modals/DepartmentModal";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";

export function DepartmentsView() {
  const router = useRouter();

  const [data, setData] = useState<Department[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [selectedDepartment, setSelectedDepartment] = useState<Department | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/departments?page=${page}&limit=10&search=${encodeURIComponent(search)}`,
      );
      const json = await res.json();
      setData(json.departments);
      setTotal(json.total);
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to load departments"));
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
    setSelectedDepartment(null);
    setRefreshTrigger(Date.now());
  };

  const handleDelete = async (department: Department) => {
    const confirmed = confirm(
      `Are you sure you want to delete department "${department.name}"? This cannot be undone.`,
    );
    if (!confirmed) return;

    try {
      const res = await fetch(`/api/departments/${department.id}`, { method: "DELETE" });
      if (res.ok) {
        handleSavedOrDeleted();
      } else {
        const errorData = await res.json().catch(() => null);
        toast.error(errorData?.error || errorData?.message || "Failed to delete department");
      }
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to delete department"));
    }
  };

  const columns: Column[] = [
    { key: "name", label: "Name", accessor: "name", width: "300px" },
    {
      key: "actions",
      label: "Actions",
      accessor: "id",
      width: "200px",
      render: (row: Department) => (
        <div className="flex space-x-2">
          <Button
            variant="outline"
            onClick={(e) => {
              e.stopPropagation();
              setSelectedDepartment(row);
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
        <h1 className="text-2xl font-semibold text-sh-blue">Departments</h1>
        <Button variant="primary" onClick={() => setSelectedDepartment({} as Department)}>
          + Add New <Plus className="w-4 h-4 ml-2" />
        </Button>
      </div>

      <TableWithFilters<Department>
        data={data}
        columns={columns}
        searchFields={[]}
        storageKey="departments"
        total={total}
        page={page}
        onPageChange={setPage}
        loading={loading}
        onRowClick={(row) => router.push(`/app/inventory/departments/${row.id}`)}
        onSearchChange={handleSearchChange}
      />

      {selectedDepartment && (
        <DepartmentModal
          department={selectedDepartment.id ? selectedDepartment : null}
          onClose={() => setSelectedDepartment(null)}
          onRefresh={handleSavedOrDeleted}
        />
      )}
    </div>
  );
}
