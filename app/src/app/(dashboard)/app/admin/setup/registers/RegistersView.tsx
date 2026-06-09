"use client";

// /app/src/app/(dashboard)/app/admin/setup/registers/RegistersView.tsx
//
// Registers body. App Router port of the legacy admin/setup/registers body
// (minus MainLayout chrome, which the (dashboard) layout supplies). Lists
// registers grouped by store location and edits them via the shared
// /api/registers REST endpoint.

import { useCallback, useEffect, useState } from "react";
import { toast } from "react-toastify";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import Modal from "@/components/ui/Modal";
import FormInput from "@/components/form/FormInput";
import FormDropdown from "@/components/form/FormDropdown";
import FormCheckbox from "@/components/form/FormCheckbox";
import { getErrorMessage } from "@/lib/toastError";

interface StoreLocation {
  id: number;
  name: string;
  code: string;
}

interface Register {
  id: number;
  name: string;
  storeLocationId: number;
  storeLocation: { name: string; code: string };
  isActive: boolean;
  sortOrder: number;
}

interface RegisterForm {
  name: string;
  storeLocationId: string;
  isActive: boolean;
  sortOrder: string;
}

const emptyForm: RegisterForm = {
  name: "",
  storeLocationId: "",
  isActive: true,
  sortOrder: "0",
};

function RegisterModal({
  register,
  storeLocations,
  defaultStoreLocationId,
  onClose,
  onRefresh,
}: {
  register: Register | null;
  storeLocations: StoreLocation[];
  defaultStoreLocationId: string;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const isEdit = register !== null;
  const [form, setForm] = useState<RegisterForm>(emptyForm);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (register) {
      setForm({
        name: register.name,
        storeLocationId: String(register.storeLocationId),
        isActive: register.isActive,
        sortOrder: String(register.sortOrder),
      });
    } else {
      setForm({ ...emptyForm, storeLocationId: defaultStoreLocationId });
    }
  }, [register, defaultStoreLocationId]);

  const handleSubmit = async () => {
    if (!form.name.trim()) return;
    if (!isEdit && !form.storeLocationId) return;

    setSaving(true);
    try {
      const url = isEdit ? `/api/registers/${register.id}` : "/api/registers";
      const method = isEdit ? "PUT" : "POST";

      const body: Record<string, unknown> = {
        name: form.name.trim(),
        isActive: form.isActive,
        sortOrder: Number.parseInt(form.sortOrder) || 0,
      };
      if (!isEdit) {
        body.storeLocationId = Number.parseInt(form.storeLocationId);
      }

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        onRefresh();
        onClose();
      } else {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        toast.error(`Failed to save register: ${data?.error || "Unknown error"}`);
      }
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Error occurred while saving."));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!register) return;

    const confirmed = confirm(
      `Are you sure you want to delete register "${register.name}"? This action cannot be undone.`,
    );
    if (!confirmed) return;

    setSaving(true);
    try {
      const res = await fetch(`/api/registers/${register.id}`, { method: "DELETE" });

      if (res.ok) {
        onRefresh();
        onClose();
      } else {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        toast.error(`Failed to delete register: ${data?.error || "Unknown error"}`);
      }
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Error occurred while deleting."));
    } finally {
      setSaving(false);
    }
  };

  const locationOptions = storeLocations.map((loc) => ({
    id: String(loc.id),
    name: loc.name,
  }));

  return (
    <Modal
      title={isEdit ? "Edit Register" : "Add Register"}
      onClose={onClose}
      onSave={handleSubmit}
      saving={saving}
    >
      <FormInput
        label="Name"
        name="registerName"
        value={form.name}
        onChange={(v) => setForm({ ...form, name: v })}
        required
      />
      {isEdit ? (
        <FormDropdown
          label="Store Location"
          options={locationOptions}
          value={form.storeLocationId}
          onChange={() => {}}
          disabled
        />
      ) : (
        <FormDropdown
          label="Store Location"
          options={locationOptions}
          value={form.storeLocationId}
          onChange={(v) => setForm({ ...form, storeLocationId: v })}
        />
      )}
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

export function RegistersView() {
  const [registers, setRegisters] = useState<Register[]>([]);
  const [storeLocations, setStoreLocations] = useState<StoreLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingRegister, setEditingRegister] = useState<Register | null>(null);
  const [defaultStoreLocationId, setDefaultStoreLocationId] = useState("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [regRes, locRes] = await Promise.all([
        fetch("/api/registers?limit=100"),
        fetch("/api/warehouse/locations"),
      ]);

      if (regRes.ok) {
        const regData = await regRes.json();
        setRegisters(regData.registers);
      }
      if (locRes.ok) {
        const locData = await locRes.json();
        setStoreLocations(locData.locations);
      }
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to load data."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleRefresh = () => {
    setModalOpen(false);
    setEditingRegister(null);
    fetchData();
  };

  const openCreateModal = (storeLocationId: number) => {
    setEditingRegister(null);
    setDefaultStoreLocationId(String(storeLocationId));
    setModalOpen(true);
  };

  const openEditModal = (register: Register) => {
    setEditingRegister(register);
    setDefaultStoreLocationId(String(register.storeLocationId));
    setModalOpen(true);
  };

  return (
    <div className="py-2 font-serif">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-serif text-sh-navy">Registers</h1>
      </div>

      {loading && <p className="text-sh-gray font-serif">Loading...</p>}

      {!loading && storeLocations.length === 0 && (
        <p className="text-sh-gray font-serif">
          No store locations configured. Add locations first in Warehouse setup.
        </p>
      )}

      {!loading && storeLocations.length > 0 && (
        <div className="space-y-6">
          {storeLocations.map((loc) => {
            const locRegisters = registers
              .filter((r) => r.storeLocationId === loc.id)
              .sort((a, b) => a.sortOrder - b.sortOrder);

            return (
              <div key={loc.id} className="bg-white rounded-xl shadow-sm border border-sh-gray/20">
                <div className="flex items-center justify-between px-6 py-4 border-b border-sh-gray/10">
                  <h2 className="text-lg font-serif text-sh-navy">{loc.name}</h2>
                  <Button variant="outline" size="sm" onClick={() => openCreateModal(loc.id)}>
                    <Plus className="w-4 h-4 mr-1" /> Add Register
                  </Button>
                </div>

                {locRegisters.length === 0 ? (
                  <p className="px-6 py-4 text-sh-gray font-serif text-sm">
                    No registers at this location.
                  </p>
                ) : (
                  <table className="w-full">
                    <thead>
                      <tr className="text-left text-sm text-sh-gray font-serif border-b border-sh-gray/10">
                        <th className="px-6 py-3">Name</th>
                        <th className="px-6 py-3">Status</th>
                        <th className="px-6 py-3">Sort Order</th>
                      </tr>
                    </thead>
                    <tbody>
                      {locRegisters.map((reg) => (
                        <tr
                          key={reg.id}
                          onClick={() => openEditModal(reg)}
                          className="border-b border-sh-gray/5 hover:bg-sh-linen cursor-pointer transition-colors"
                        >
                          <td className="px-6 py-3 font-serif text-sh-navy">{reg.name}</td>
                          <td className="px-6 py-3">
                            <span
                              className={`inline-block px-2 py-0.5 rounded-full text-xs font-serif-condensed font-semibold ${
                                reg.isActive
                                  ? "bg-green-100 text-green-800"
                                  : "bg-sh-gray/20 text-sh-gray"
                              }`}
                            >
                              {reg.isActive ? "Active" : "Inactive"}
                            </span>
                          </td>
                          <td className="px-6 py-3 font-serif text-sh-gray">{reg.sortOrder}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            );
          })}
        </div>
      )}

      {modalOpen && (
        <RegisterModal
          register={editingRegister}
          storeLocations={storeLocations}
          defaultStoreLocationId={defaultStoreLocationId}
          onClose={() => {
            setModalOpen(false);
            setEditingRegister(null);
          }}
          onRefresh={handleRefresh}
        />
      )}
    </div>
  );
}
