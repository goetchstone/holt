// /app/src/components/modals/StockLocationModal.tsx

import { useState, useEffect } from "react";
import FormInput from "@/components/form/FormInput";
import { Button } from "@/components/ui/button";
import Modal from "@/components/ui/Modal";

interface StockLocationData {
  id: number;
  code: string;
  name: string;
  description: string | null;
  building: string | null;
  floor: number | null;
  area: number | null;
  locationType: string;
  squareFootage: number | null;
  locationAliases: string[];
  isActive: boolean;
}

type Props = {
  stockLocation: StockLocationData | null;
  storeLocationId: number;
  onClose: () => void;
  onRefresh: () => void;
};

export default function StockLocationModal({
  stockLocation,
  storeLocationId,
  onClose,
  onRefresh,
}: Props) {
  const [form, setForm] = useState({
    code: "",
    name: "",
    description: "",
    building: "",
    floor: "",
    locationType: "STOCK",
    squareFootage: "",
    locationAliases: "",
  });
  const [isActive, setIsActive] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (stockLocation) {
      setForm({
        code: stockLocation.code || "",
        name: stockLocation.name || "",
        description: stockLocation.description || "",
        building: stockLocation.building || "",
        floor: stockLocation.floor?.toString() || "",
        locationType: stockLocation.locationType || "STOCK",
        squareFootage: stockLocation.squareFootage?.toString() || "",
        locationAliases: (stockLocation.locationAliases || []).join(", "),
      });
      setIsActive(stockLocation.isActive);
    } else {
      setForm({
        code: "",
        name: "",
        description: "",
        building: "",
        floor: "",
        locationType: "STOCK",
        squareFootage: "",
        locationAliases: "",
      });
      setIsActive(true);
    }
  }, [stockLocation]);

  const handleChange = (name: string, value: string) => {
    setForm({ ...form, [name]: value });
  };

  const handleSubmit = async () => {
    if (!form.code.trim() || !form.name.trim()) {
      alert("Code and name are required.");
      return;
    }

    setSaving(true);
    const method = stockLocation ? "PUT" : "POST";
    const url = stockLocation
      ? `/api/warehouse/stock-locations/${stockLocation.id}`
      : `/api/warehouse/locations/${storeLocationId}/stock-locations`;

    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: form.code,
          name: form.name,
          description: form.description || null,
          building: form.building || null,
          floor: form.floor ? Number.parseInt(form.floor) : null,
          locationType: form.locationType,
          squareFootage:
            form.locationType === "FLOOR" && form.squareFootage
              ? Number.parseInt(form.squareFootage)
              : null,
          locationAliases: form.locationAliases
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          isActive,
        }),
      });

      if (res.ok) {
        onRefresh();
        onClose();
      } else {
        const data = await res.json();
        alert(data.error || "Failed to save stock location.");
      }
    } catch {
      alert("Error saving stock location.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!stockLocation) return;
    const confirmed = confirm(
      `Delete stock location "${stockLocation.name}"? This cannot be undone.`,
    );
    if (!confirmed) return;

    setSaving(true);
    try {
      const res = await fetch(`/api/warehouse/stock-locations/${stockLocation.id}`, {
        method: "DELETE",
      });
      if (res.ok) {
        onRefresh();
        onClose();
      } else {
        const data = await res.json();
        alert(data.error || "Failed to delete stock location.");
      }
    } catch {
      alert("Error deleting stock location.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={stockLocation ? "Edit Stock Location" : "Add Stock Location"}
      onClose={onClose}
      onSave={handleSubmit}
      saving={saving}
    >
      <div className="grid grid-cols-2 gap-4">
        <FormInput
          label="Code"
          name="code"
          value={form.code}
          onChange={(v) => handleChange("code", v)}
          required
        />
        <FormInput
          label="Name"
          name="name"
          value={form.name}
          onChange={(v) => handleChange("name", v)}
          required
        />
      </div>
      <FormInput
        label="Description"
        name="description"
        value={form.description}
        onChange={(v) => handleChange("description", v)}
      />
      <div className="grid grid-cols-2 gap-4">
        <FormInput
          label="Building"
          name="building"
          value={form.building}
          onChange={(v) => handleChange("building", v)}
        />
        <FormInput
          label="Floor"
          name="floor"
          type="number"
          value={form.floor}
          onChange={(v) => handleChange("floor", v)}
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm text-sh-gray mb-1">Location Type</label>
          <select
            value={form.locationType}
            onChange={(e) => handleChange("locationType", e.target.value)}
            className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
          >
            <option value="STOCK">Stock</option>
            <option value="FLOOR">Floor</option>
          </select>
        </div>
        {form.locationType === "FLOOR" && (
          <FormInput
            label="Square Footage"
            name="squareFootage"
            type="number"
            value={form.squareFootage}
            onChange={(v) => handleChange("squareFootage", v)}
          />
        )}
      </div>
      <div>
        <FormInput
          label="Location Aliases"
          name="locationAliases"
          value={form.locationAliases}
          onChange={(v) => handleChange("locationAliases", v)}
          placeholder="Comma-separated external location names"
        />
        <p className="text-[10px] text-sh-gray mt-0.5">
          External location names that map to this USL during import (e.g. &quot;NB 2nd Floor Area
          4, NB Attic&quot;)
        </p>
      </div>
      {stockLocation && (
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="slIsActive"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
            className="rounded"
          />
          <label htmlFor="slIsActive" className="text-sm text-sh-gray">
            Active
          </label>
        </div>
      )}
      {stockLocation && (
        <div className="flex justify-end mt-2">
          <Button variant="secondary" onClick={handleDelete} disabled={saving}>
            Delete
          </Button>
        </div>
      )}
    </Modal>
  );
}
