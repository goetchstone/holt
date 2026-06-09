"use client";

// /app/src/app/(dashboard)/app/admin/setup/printers/PrintersView.tsx
//
// Printers list. App Router port of the legacy admin/setup/printers/index body.
// Replicates StandardListPage's search + pagination inline (the (dashboard)
// layout supplies the chrome), reading the shared /api/printers REST endpoint.
// Edit/create modal + delete preserved; row click opens the detail route.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Printer } from "@prisma/client";
import { toast } from "react-toastify";
import { Pencil, Plus, Trash2 } from "lucide-react";
import TableWithFilters from "@/components/table/TableWithFilters";
import { type Column } from "@/components/table/PaginatedTable";
import PrinterModal from "@/components/modals/PrinterModal";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";

export function PrintersView() {
  const router = useRouter();

  const [data, setData] = useState<Printer[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [selectedPrinter, setSelectedPrinter] = useState<Printer | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/printers?page=${page}&limit=10&search=${encodeURIComponent(search)}`,
      );
      const json = await res.json();
      setData(json.printers);
      setTotal(json.total);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to load printers"));
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
    setSelectedPrinter(null);
    setRefreshTrigger(Date.now());
  };

  const handleDeletePrinter = async (printer: Printer) => {
    const confirmed = confirm(
      `Are you sure you want to delete printer "${printer.name}"? This cannot be undone.`,
    );
    if (!confirmed) return;

    try {
      const res = await fetch(`/api/printers/${printer.id}`, { method: "DELETE" });
      if (res.ok) {
        handleSavedOrDeleted();
      } else {
        const errorData = (await res.json().catch(() => null)) as {
          error?: string;
          message?: string;
        } | null;
        toast.error(
          `Failed to delete printer: ${errorData?.error || errorData?.message || "Unknown error"}`,
        );
      }
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Error occurred while deleting printer."));
    }
  };

  const columns: Column[] = [
    { key: "name", label: "Name", accessor: "name", width: "120px" },
    { key: "location", label: "Location", accessor: "location", width: "120px" },
    { key: "ipAddress", label: "IP Address", accessor: "ipAddress", width: "150px" },
    { key: "tagType", label: "Tag Type", accessor: "tagType", width: "100px" },
    { key: "store", label: "Store", accessor: "store", width: "100px" },
    {
      key: "actions",
      label: "Actions",
      accessor: "id",
      width: "200px",
      render: (row: Printer) => (
        <div className="flex space-x-2">
          <Button
            variant="outline"
            onClick={(e) => {
              e.stopPropagation();
              setSelectedPrinter(row);
            }}
          >
            Edit <Pencil className="w-4 h-4 ml-2" />
          </Button>
          <Button
            variant="secondary"
            onClick={(e) => {
              e.stopPropagation();
              handleDeletePrinter(row);
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
        <h1 className="text-2xl font-semibold text-sh-blue">Printers</h1>
        <Button variant="primary" onClick={() => setSelectedPrinter({} as Printer)}>
          Add New <Plus className="w-4 h-4 ml-2" />
        </Button>
      </div>

      <TableWithFilters<Printer>
        data={data}
        columns={columns}
        searchFields={[]}
        storageKey="printers"
        total={total}
        page={page}
        onPageChange={setPage}
        loading={loading}
        onRowClick={(row) => router.push(`/app/admin/setup/printers/${row.id}`)}
        onSearchChange={handleSearchChange}
      />

      {selectedPrinter && (
        <PrinterModal
          printer={selectedPrinter.id ? selectedPrinter : null}
          onClose={() => setSelectedPrinter(null)}
          onRefresh={handleSavedOrDeleted}
        />
      )}
    </div>
  );
}
