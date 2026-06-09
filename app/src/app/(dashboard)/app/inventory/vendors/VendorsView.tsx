"use client";

// /app/src/app/(dashboard)/app/inventory/vendors/VendorsView.tsx
//
// Vendors list. App Router port of the legacy inventory/vendors/index body.
// Replicates StandardListPage's search + pagination inline (the (dashboard)
// layout supplies the chrome), reading the shared /api/vendors REST endpoint.
// Edit modal + inline create-vendor dialog preserved.

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Vendor } from "@prisma/client";
import { Dialog, DialogPanel, DialogTitle, DialogBackdrop } from "@headlessui/react";
import { toast } from "react-toastify";
import { Pencil, Plus, Loader2 } from "lucide-react";
import TableWithFilters from "@/components/table/TableWithFilters";
import { type Column } from "@/components/table/PaginatedTable";
import VendorDetailModal from "@/components/modals/VendorDetailModal";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";

export function VendorsView() {
  const router = useRouter();

  const [data, setData] = useState<Vendor[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [selectedVendor, setSelectedVendor] = useState<Vendor | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newVendorName, setNewVendorName] = useState("");
  const [creating, setCreating] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/vendors?page=${page}&limit=10&search=${encodeURIComponent(search)}`,
      );
      const json = await res.json();
      setData(json.vendors);
      setTotal(json.total);
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to load vendors"));
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

  const handleVendorSaved = () => {
    setSelectedVendor(null);
    setRefreshTrigger(Date.now());
  };

  const handleCreateVendor = async () => {
    const name = newVendorName.trim();
    if (!name) {
      toast.error("Vendor name is required");
      return;
    }
    setCreating(true);
    try {
      const res = await fetch("/api/vendors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to create vendor");
        return;
      }
      const vendor = await res.json();
      toast.success(`Vendor "${vendor.name}" created`);
      setShowCreateModal(false);
      setNewVendorName("");
      setRefreshTrigger(Date.now());
      router.push(`/app/inventory/vendors/${vendor.id}`);
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to create vendor"));
    } finally {
      setCreating(false);
    }
  };

  const columns: Column[] = [
    { key: "name", label: "Name", accessor: "name", width: "200px" },
    { key: "email", label: "Email", accessor: "email", width: "200px" },
    { key: "phone", label: "Phone", accessor: "phone", width: "150px" },
    { key: "city", label: "City", accessor: "city", width: "150px" },
    {
      key: "actions",
      label: "Actions",
      accessor: "id",
      width: "120px",
      render: (row: Vendor) => (
        <div className="flex space-x-2">
          <Button
            variant="outline"
            onClick={(e) => {
              e.stopPropagation();
              setSelectedVendor(row);
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
        <h1 className="text-2xl font-semibold text-sh-blue">Vendors</h1>
        <Button variant="primary" onClick={() => setShowCreateModal(true)}>
          Add New <Plus className="w-4 h-4 ml-2" />
        </Button>
      </div>

      <TableWithFilters<Vendor>
        data={data}
        columns={columns}
        searchFields={[]}
        storageKey="vendors"
        total={total}
        page={page}
        onPageChange={setPage}
        loading={loading}
        onRowClick={(row) => router.push(`/app/inventory/vendors/${row.id}`)}
        onSearchChange={handleSearchChange}
      />

      {selectedVendor && (
        <VendorDetailModal
          vendor={selectedVendor}
          onClose={() => setSelectedVendor(null)}
          onRefresh={handleVendorSaved}
        />
      )}

      {/* Create vendor modal */}
      <Dialog
        open={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        className="relative z-50"
      >
        <DialogBackdrop className="fixed inset-0 bg-black/50" />
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <DialogPanel className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl font-serif">
            <DialogTitle as="h3" className="text-lg font-semibold text-sh-blue mb-4">
              Add New Vendor
            </DialogTitle>
            <label htmlFor="new-vendor-name" className="sr-only">
              Vendor name
            </label>
            <input
              id="new-vendor-name"
              type="text"
              value={newVendorName}
              onChange={(e) => setNewVendorName(e.target.value)}
              placeholder="Vendor name"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreateVendor();
              }}
              className="w-full border border-sh-gray/30 rounded-lg px-3 py-2 text-sm text-sh-black font-serif mb-4"
            />
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setShowCreateModal(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={handleCreateVendor} disabled={creating}>
                {creating ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Creating...
                  </>
                ) : (
                  "Create Vendor"
                )}
              </Button>
            </div>
          </DialogPanel>
        </div>
      </Dialog>
    </div>
  );
}
