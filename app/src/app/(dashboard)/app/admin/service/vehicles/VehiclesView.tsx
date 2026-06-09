"use client";

// /app/src/app/(dashboard)/app/admin/service/vehicles/VehiclesView.tsx
//
// Vehicles body. App Router port of the legacy admin/service/vehicles body
// (minus MainLayout chrome, which the (dashboard) layout supplies). Manages the
// delivery-vehicle roster via the shared /api/dispatch/vehicles REST endpoints.

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import Modal from "@/components/ui/Modal";
import FormInput from "@/components/form/FormInput";
import { getErrorMessage } from "@/lib/toastError";

interface Vehicle {
  id: number;
  name: string;
  type: string;
  licensePlate: string | null;
  capacity: number;
  notes: string | null;
  isActive: boolean;
}

interface VehicleForm {
  name: string;
  type: string;
  licensePlate: string;
  capacity: string;
  notes: string;
  isActive: boolean;
}

const EMPTY_FORM: VehicleForm = {
  name: "",
  type: "BOX_TRUCK",
  licensePlate: "",
  capacity: "6",
  notes: "",
  isActive: true,
};

const VEHICLE_TYPE_LABELS: Record<string, string> = {
  BOX_TRUCK: "Box Truck",
  VAN: "Van",
  RENTAL: "Rental",
};

const VEHICLE_TYPE_OPTIONS = [
  { value: "BOX_TRUCK", label: "Box Truck" },
  { value: "VAN", label: "Van" },
  { value: "RENTAL", label: "Rental" },
];

function StatusBadge({ active }: { active: boolean }) {
  const cls = active ? "bg-green-100 text-green-800" : "bg-sh-gray/20 text-sh-gray";
  return (
    <span className={`text-xs px-2 py-0.5 rounded ${cls}`}>{active ? "Active" : "Inactive"}</span>
  );
}

function VehicleTypeSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <select
      id={id}
      className="border border-sh-gray/30 rounded px-3 py-2 text-sm w-full"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {VEHICLE_TYPE_OPTIONS.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

export function VehiclesView() {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addForm, setAddForm] = useState<VehicleForm>({ ...EMPTY_FORM });
  const [addSaving, setAddSaving] = useState(false);

  const [editModal, setEditModal] = useState<{ vehicle: Vehicle } | null>(null);
  const [editForm, setEditForm] = useState<VehicleForm>({ ...EMPTY_FORM });
  const [editSaving, setEditSaving] = useState(false);

  const loadVehicles = useCallback(async () => {
    try {
      const res = await axios.get("/api/dispatch/vehicles");
      setVehicles(res.data.vehicles || []);
    } catch {
      toast.error("Failed to load vehicles");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadVehicles();
  }, [loadVehicles]);

  const handleAdd = async () => {
    if (!addForm.name.trim()) {
      toast.error("Name is required");
      return;
    }
    setAddSaving(true);
    try {
      await axios.post("/api/dispatch/vehicles", {
        name: addForm.name.trim(),
        type: addForm.type,
        licensePlate: addForm.licensePlate.trim() || null,
        capacity: Number.parseInt(addForm.capacity) || 6,
        notes: addForm.notes.trim() || null,
      });
      toast.success("Vehicle added");
      setAddForm({ ...EMPTY_FORM });
      setShowAddForm(false);
      await loadVehicles();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to add vehicle"));
    } finally {
      setAddSaving(false);
    }
  };

  const openEdit = (vehicle: Vehicle) => {
    setEditForm({
      name: vehicle.name,
      type: vehicle.type,
      licensePlate: vehicle.licensePlate || "",
      capacity: String(vehicle.capacity),
      notes: vehicle.notes || "",
      isActive: vehicle.isActive,
    });
    setEditModal({ vehicle });
  };

  const handleEdit = async () => {
    if (!editModal || !editForm.name.trim()) {
      toast.error("Name is required");
      return;
    }
    setEditSaving(true);
    try {
      await axios.put(`/api/dispatch/vehicles/${editModal.vehicle.id}`, {
        name: editForm.name.trim(),
        type: editForm.type,
        licensePlate: editForm.licensePlate.trim() || null,
        capacity: Number.parseInt(editForm.capacity) || 6,
        notes: editForm.notes.trim() || null,
        isActive: editForm.isActive,
      });
      toast.success("Vehicle updated");
      setEditModal(null);
      await loadVehicles();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to update vehicle"));
    } finally {
      setEditSaving(false);
    }
  };

  if (loading) {
    return <p className="text-sh-gray py-8">Loading...</p>;
  }

  return (
    <>
      <div className="py-2 space-y-6 font-serif">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl text-sh-blue font-semibold">Vehicle Management</h1>
          <Button
            variant="primary"
            onClick={() => {
              setShowAddForm(!showAddForm);
              setAddForm({ ...EMPTY_FORM });
            }}
          >
            {showAddForm ? "Cancel" : "Add Vehicle"}
          </Button>
        </div>

        {/* Add Form */}
        {showAddForm && (
          <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-6">
            <h2 className="text-lg font-semibold text-sh-black mb-4">New Vehicle</h2>
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div>
                <label htmlFor="addName" className="block text-xs font-medium text-sh-gray mb-1">
                  Name *
                </label>
                <input
                  id="addName"
                  type="text"
                  className="border border-sh-gray/30 rounded px-3 py-2 text-sm w-full"
                  value={addForm.name}
                  onChange={(e) => setAddForm((f) => ({ ...f, name: e.target.value }))}
                />
              </div>
              <div>
                <label htmlFor="addType" className="block text-xs font-medium text-sh-gray mb-1">
                  Type
                </label>
                <VehicleTypeSelect
                  id="addType"
                  value={addForm.type}
                  onChange={(v) => setAddForm((f) => ({ ...f, type: v }))}
                />
              </div>
              <div>
                <label htmlFor="addPlate" className="block text-xs font-medium text-sh-gray mb-1">
                  License Plate
                </label>
                <input
                  id="addPlate"
                  type="text"
                  className="border border-sh-gray/30 rounded px-3 py-2 text-sm w-full"
                  value={addForm.licensePlate}
                  onChange={(e) => setAddForm((f) => ({ ...f, licensePlate: e.target.value }))}
                />
              </div>
              <div>
                <label
                  htmlFor="addCapacity"
                  className="block text-xs font-medium text-sh-gray mb-1"
                >
                  Capacity
                </label>
                <input
                  id="addCapacity"
                  type="number"
                  className="border border-sh-gray/30 rounded px-3 py-2 text-sm w-full"
                  value={addForm.capacity}
                  onChange={(e) => setAddForm((f) => ({ ...f, capacity: e.target.value }))}
                />
              </div>
            </div>
            <div className="mb-4">
              <label htmlFor="addNotes" className="block text-xs font-medium text-sh-gray mb-1">
                Notes
              </label>
              <textarea
                id="addNotes"
                className="border border-sh-gray/30 rounded px-3 py-2 text-sm w-full"
                rows={2}
                value={addForm.notes}
                onChange={(e) => setAddForm((f) => ({ ...f, notes: e.target.value }))}
              />
            </div>
            <div className="flex justify-end">
              <Button disabled={addSaving} onClick={handleAdd}>
                {addSaving ? "Saving..." : "Save Vehicle"}
              </Button>
            </div>
          </div>
        )}

        {/* Table */}
        <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-sh-gray/20 bg-sh-stripe">
                <th className="text-left px-4 py-3 font-medium text-sh-gray">Name</th>
                <th className="text-left px-4 py-3 font-medium text-sh-gray">Type</th>
                <th className="text-left px-4 py-3 font-medium text-sh-gray">License Plate</th>
                <th className="text-left px-4 py-3 font-medium text-sh-gray">Capacity</th>
                <th className="text-left px-4 py-3 font-medium text-sh-gray w-[90px]">Active</th>
                <th className="text-right px-4 py-3 font-medium text-sh-gray w-[80px]">Actions</th>
              </tr>
            </thead>
            <tbody>
              {vehicles.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-sh-gray">
                    No vehicles configured
                  </td>
                </tr>
              ) : (
                vehicles.map((v) => (
                  <tr key={v.id} className="border-b border-sh-gray/10 hover:bg-sh-stripe/50">
                    <td className="px-4 py-2 text-sh-black font-medium">{v.name}</td>
                    <td className="px-4 py-2 text-sh-gray">
                      {VEHICLE_TYPE_LABELS[v.type] || v.type}
                    </td>
                    <td className="px-4 py-2 text-sh-gray">{v.licensePlate || "--"}</td>
                    <td className="px-4 py-2 text-sh-gray">{v.capacity}</td>
                    <td className="px-4 py-2">
                      <StatusBadge active={v.isActive} />
                    </td>
                    <td className="px-4 py-2 text-right">
                      <button
                        onClick={() => openEdit(v)}
                        className="text-sm text-sh-blue hover:underline"
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Edit Modal */}
      {editModal && (
        <Modal
          title="Edit Vehicle"
          onClose={() => setEditModal(null)}
          onSave={handleEdit}
          saving={editSaving}
        >
          <FormInput
            label="Name"
            name="editName"
            value={editForm.name}
            onChange={(v) => setEditForm((f) => ({ ...f, name: v }))}
            required
          />
          <div className="mb-3">
            <label htmlFor="editType" className="block text-xs font-medium text-sh-gray mb-1">
              Type
            </label>
            <VehicleTypeSelect
              id="editType"
              value={editForm.type}
              onChange={(v) => setEditForm((f) => ({ ...f, type: v }))}
            />
          </div>
          <FormInput
            label="License Plate"
            name="editLicensePlate"
            value={editForm.licensePlate}
            onChange={(v) => setEditForm((f) => ({ ...f, licensePlate: v }))}
          />
          <FormInput
            label="Capacity"
            name="editCapacity"
            value={editForm.capacity}
            onChange={(v) => setEditForm((f) => ({ ...f, capacity: v }))}
          />
          <div className="mb-3">
            <label htmlFor="editNotes" className="block text-xs font-medium text-sh-gray mb-1">
              Notes
            </label>
            <textarea
              id="editNotes"
              className="border border-sh-gray/30 rounded px-3 py-2 text-sm w-full"
              rows={2}
              value={editForm.notes}
              onChange={(e) => setEditForm((f) => ({ ...f, notes: e.target.value }))}
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="editActive"
              checked={editForm.isActive}
              onChange={(e) => setEditForm((f) => ({ ...f, isActive: e.target.checked }))}
              className="rounded"
            />
            <label htmlFor="editActive" className="text-sm text-sh-gray">
              Active
            </label>
          </div>
        </Modal>
      )}
    </>
  );
}
