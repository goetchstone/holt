"use client";

// /app/src/app/(dashboard)/app/admin/setup/labels/LabelTemplatesView.tsx
//
// Label Templates list. App Router port of the legacy admin/setup/labels/index
// body. Replicates StandardListPage's search + pagination inline (the
// (dashboard) layout supplies the chrome), reading the shared /api/labels REST
// endpoint. Edit/create modal + delete preserved; row click opens the detail
// route.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LabelTemplate } from "@prisma/client";
import { toast } from "react-toastify";
import { Pencil, Plus, Trash2 } from "lucide-react";
import TableWithFilters from "@/components/table/TableWithFilters";
import { type Column } from "@/components/table/PaginatedTable";
import LabelTemplateModal from "@/components/modals/LabelTemplateModal";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";

export function LabelTemplatesView() {
  const router = useRouter();

  const [data, setData] = useState<LabelTemplate[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<LabelTemplate | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/labels?page=${page}&limit=10&search=${encodeURIComponent(search)}`,
      );
      const json = await res.json();
      setData(json.templates);
      setTotal(json.total);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to load label templates"));
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
    setSelectedTemplate(null);
    setRefreshTrigger(Date.now());
  };

  const handleDeleteTemplate = async (template: LabelTemplate) => {
    const confirmed = confirm(
      `Are you sure you want to delete label template "${template.name}"? This cannot be undone.`,
    );
    if (!confirmed) return;

    try {
      const res = await fetch(`/api/templates/${template.id}`, { method: "DELETE" });
      if (res.ok) {
        handleSavedOrDeleted();
      } else {
        const errorData = (await res.json().catch(() => null)) as {
          error?: string;
          message?: string;
        } | null;
        toast.error(
          `Failed to delete label template: ${
            errorData?.error || errorData?.message || "Unknown error"
          }`,
        );
      }
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Error occurred while deleting label template."));
    }
  };

  const columns: Column[] = [
    { key: "name", label: "Name", accessor: "name", width: "150px" },
    { key: "context", label: "Context", accessor: "context", width: "150px" },
    { key: "tagSize", label: "Tag Size", accessor: "tagSize", width: "150px" },
    {
      key: "actions",
      label: "Actions",
      accessor: "id",
      width: "200px",
      render: (row: LabelTemplate) => (
        <div className="flex space-x-2">
          <Button
            variant="outline"
            onClick={(e) => {
              e.stopPropagation();
              setSelectedTemplate(row);
            }}
          >
            Edit <Pencil className="w-4 h-4 ml-2" />
          </Button>
          <Button
            variant="secondary"
            onClick={(e) => {
              e.stopPropagation();
              handleDeleteTemplate(row);
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
        <h1 className="text-2xl font-semibold text-sh-blue">Label Templates</h1>
        <Button variant="primary" onClick={() => setSelectedTemplate({} as LabelTemplate)}>
          Add New <Plus className="w-4 h-4 ml-2" />
        </Button>
      </div>

      <TableWithFilters<LabelTemplate>
        data={data}
        columns={columns}
        searchFields={[]}
        storageKey="labelTemplates"
        total={total}
        page={page}
        onPageChange={setPage}
        loading={loading}
        onRowClick={(row) => router.push(`/app/admin/setup/labels/${row.id}`)}
        onSearchChange={handleSearchChange}
      />

      {selectedTemplate && (
        <LabelTemplateModal
          template={selectedTemplate.id ? selectedTemplate : null}
          onClose={() => setSelectedTemplate(null)}
          onRefresh={handleSavedOrDeleted}
        />
      )}
    </div>
  );
}
