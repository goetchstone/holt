"use client";

// /app/src/app/(dashboard)/app/admin/setup/stores/StoresView.tsx
//
// Store Locations body. App Router port of the legacy admin/setup/stores body
// (minus MainLayout chrome, which the (dashboard) layout supplies). CRUD over
// the shared /api/warehouse/locations REST endpoint.

import { useCallback, useEffect, useState } from "react";
import { toast } from "react-toastify";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import Modal from "@/components/ui/Modal";
import FormInput from "@/components/form/FormInput";
import FormDropdown from "@/components/form/FormDropdown";
import FormCheckbox from "@/components/form/FormCheckbox";
import { getErrorMessage } from "@/lib/toastError";

type LocationType = "STORE" | "WAREHOUSE" | "OFFSITE";

interface StoreLocation {
  id: number;
  name: string;
  code: string;
  type: LocationType;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  isActive: boolean;
  sortOrder: number;
  externalLocationName: string | null;
}

interface StoreForm {
  name: string;
  code: string;
  type: LocationType;
  address: string;
  city: string;
  state: string;
  zip: string;
  externalLocationName: string;
  isActive: boolean;
  sortOrder: string;
}

const emptyForm: StoreForm = {
  name: "",
  code: "",
  type: "STORE",
  address: "",
  city: "",
  state: "",
  zip: "",
  externalLocationName: "",
  isActive: true,
  sortOrder: "0",
};

const typeOptions = [
  { id: "STORE", name: "Store" },
  { id: "WAREHOUSE", name: "Warehouse" },
  { id: "OFFSITE", name: "Offsite" },
];

const typeBadgeClasses: Record<LocationType, string> = {
  STORE: "bg-blue-100 text-blue-800",
  WAREHOUSE: "bg-amber-100 text-amber-800",
  OFFSITE: "bg-sh-gray/20 text-sh-gray",
};

function StoreModal({
  store,
  onClose,
  onRefresh,
}: {
  store: StoreLocation | null;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const isEdit = store !== null;
  const [form, setForm] = useState<StoreForm>(emptyForm);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (store) {
      setForm({
        name: store.name,
        code: store.code,
        type: store.type,
        address: store.address || "",
        city: store.city || "",
        state: store.state || "",
        zip: store.zip || "",
        externalLocationName: store.externalLocationName || "",
        isActive: store.isActive,
        sortOrder: String(store.sortOrder),
      });
    } else {
      setForm(emptyForm);
    }
  }, [store]);

  const handleSubmit = async () => {
    if (!form.name.trim() || !form.code.trim()) return;

    setSaving(true);
    try {
      const url = isEdit ? `/api/warehouse/locations/${store.id}` : "/api/warehouse/locations";
      const method = isEdit ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          code: form.code.trim(),
          type: form.type,
          address: form.address.trim() || null,
          city: form.city.trim() || null,
          state: form.state.trim() || null,
          zip: form.zip.trim() || null,
          externalLocationName: form.externalLocationName.trim() || null,
          isActive: form.isActive,
          sortOrder: Number.parseInt(form.sortOrder) || 0,
        }),
      });

      if (res.ok) {
        onRefresh();
        onClose();
      } else {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        toast.error(`Failed to save store: ${data?.error || "Unknown error"}`);
      }
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Error occurred while saving."));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!store) return;

    const confirmed = confirm(
      `Are you sure you want to delete "${store.name}"? This action cannot be undone.`,
    );
    if (!confirmed) return;

    setSaving(true);
    try {
      const res = await fetch(`/api/warehouse/locations/${store.id}`, { method: "DELETE" });

      if (res.ok) {
        onRefresh();
        onClose();
      } else {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        toast.error(`Failed to delete store: ${data?.error || "Unknown error"}`);
      }
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Error occurred while deleting."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={isEdit ? "Edit Store Location" : "Add Store Location"}
      onClose={onClose}
      onSave={handleSubmit}
      saving={saving}
    >
      <FormInput
        label="Name"
        name="name"
        value={form.name}
        onChange={(v) => setForm({ ...form, name: v })}
        required
      />
      <FormInput
        label="Code"
        name="code"
        value={form.code}
        onChange={(v) => setForm({ ...form, code: v })}
        required
      />
      <FormDropdown
        label="Type"
        options={typeOptions}
        value={form.type}
        onChange={(v) => setForm({ ...form, type: v as LocationType })}
      />
      <FormInput
        label="Address"
        name="address"
        value={form.address}
        onChange={(v) => setForm({ ...form, address: v })}
      />
      <div className="grid grid-cols-3 gap-3">
        <FormInput
          label="City"
          name="city"
          value={form.city}
          onChange={(v) => setForm({ ...form, city: v })}
        />
        <FormInput
          label="State"
          name="state"
          value={form.state}
          onChange={(v) => setForm({ ...form, state: v })}
        />
        <FormInput
          label="Zip"
          name="zip"
          value={form.zip}
          onChange={(v) => setForm({ ...form, zip: v })}
        />
      </div>
      <FormInput
        label="the POS Location Name"
        name="externalLocationName"
        value={form.externalLocationName}
        onChange={(v) => setForm({ ...form, externalLocationName: v })}
      />
      <FormCheckbox
        label="Active"
        name="isActive"
        checked={form.isActive}
        onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
      />
      <FormInput
        label="Sort Order"
        name="sortOrder"
        type="number"
        value={form.sortOrder}
        onChange={(v) => setForm({ ...form, sortOrder: v })}
      />

      {isEdit && (
        <div className="flex justify-end gap-4 mt-4">
          <Button variant="secondary" onClick={handleDelete} disabled={saving}>
            Delete
          </Button>
        </div>
      )}
    </Modal>
  );
}

export function StoresView() {
  const [stores, setStores] = useState<StoreLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingStore, setEditingStore] = useState<StoreLocation | null>(null);

  const fetchStores = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/warehouse/locations");
      if (res.ok) {
        const data = await res.json();
        setStores(data.locations);
      }
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to load store locations."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStores();
  }, [fetchStores]);

  const handleRefresh = () => {
    setModalOpen(false);
    setEditingStore(null);
    fetchStores();
  };

  const openCreateModal = () => {
    setEditingStore(null);
    setModalOpen(true);
  };

  const openEditModal = (store: StoreLocation) => {
    setEditingStore(store);
    setModalOpen(true);
  };

  return (
    <div className="py-2 font-serif">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-serif text-sh-navy">Store Locations</h1>
        <Button variant="primary" onClick={openCreateModal}>
          <Plus className="w-4 h-4 mr-1" /> Add Store
        </Button>
      </div>

      {loading && <p className="text-sh-gray font-serif">Loading...</p>}

      {!loading && stores.length === 0 && (
        <p className="text-sh-gray font-serif">No store locations configured.</p>
      )}

      {!loading && stores.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-sh-gray/20">
          <table className="w-full">
            <thead>
              <tr className="text-left text-sm text-sh-gray font-serif border-b border-sh-gray/10">
                <th className="px-6 py-3">Name</th>
                <th className="px-6 py-3">Code</th>
                <th className="px-6 py-3">Type</th>
                <th className="px-6 py-3">Address</th>
                <th className="px-6 py-3">Active</th>
                <th className="px-6 py-3">Sort Order</th>
              </tr>
            </thead>
            <tbody>
              {stores.map((store) => (
                <tr
                  key={store.id}
                  onClick={() => openEditModal(store)}
                  className="border-b border-sh-gray/5 hover:bg-sh-linen cursor-pointer transition-colors"
                >
                  <td className="px-6 py-3 font-serif text-sh-navy">{store.name}</td>
                  <td className="px-6 py-3 font-serif text-sh-gray">{store.code}</td>
                  <td className="px-6 py-3">
                    <span
                      className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${typeBadgeClasses[store.type]}`}
                    >
                      {store.type}
                    </span>
                  </td>
                  <td className="px-6 py-3 font-serif text-sh-gray">
                    {[store.city, store.state].filter(Boolean).join(", ") || "--"}
                  </td>
                  <td className="px-6 py-3">
                    <span
                      className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${
                        store.isActive ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"
                      }`}
                    >
                      {store.isActive ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="px-6 py-3 font-serif text-sh-gray">{store.sortOrder}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modalOpen && (
        <StoreModal
          store={editingStore}
          onClose={() => {
            setModalOpen(false);
            setEditingStore(null);
          }}
          onRefresh={handleRefresh}
        />
      )}
    </div>
  );
}
