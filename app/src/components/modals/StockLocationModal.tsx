// /app/src/components/modals/StockLocationModal.tsx

import { useState, useEffect } from "react";
import FormInput from "@/components/form/FormInput";
import { Button } from "@/components/ui/button";
import Modal from "@/components/ui/Modal";
import { LOCATION_TYPE_INFO, STOCK_LOCATION_TYPES } from "@/lib/inventory/locationTypes";
import { descendantIds, treeOrder } from "@/lib/inventory/placeTree";

interface StockLocationData {
  id: number;
  code: string;
  name: string;
  description: string | null;
  parentId: number | null;
  locationType: string;
  squareFootage: number | null;
  locationAliases: string[];
  isActive: boolean;
  holdsCommittedStock: boolean;
  moveMode?: string | null;
}

type Props = {
  stockLocation: StockLocationData | null;
  storeLocationId: number;
  /** The store's places, for the "Inside" picker. */
  places: {
    id: number;
    code: string;
    name: string;
    parentId: number | null;
    sortOrder: number;
    isActive: boolean;
  }[];
  onClose: () => void;
  onRefresh: () => void;
};

export default function StockLocationModal({
  stockLocation,
  storeLocationId,
  places,
  onClose,
  onRefresh,
}: Props) {
  const [form, setForm] = useState({
    code: "",
    name: "",
    description: "",
    parentId: "",
    locationType: "STOCK",
    squareFootage: "",
    locationAliases: "",
    moveMode: "",
  });
  const [isActive, setIsActive] = useState(true);
  const [holdsCommittedStock, setHoldsCommittedStock] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (stockLocation) {
      setForm({
        code: stockLocation.code || "",
        name: stockLocation.name || "",
        description: stockLocation.description || "",
        parentId: stockLocation.parentId?.toString() || "",
        locationType: stockLocation.locationType || "STOCK",
        squareFootage: stockLocation.squareFootage?.toString() || "",
        locationAliases: (stockLocation.locationAliases || []).join(", "),
        moveMode: stockLocation.moveMode ?? "",
      });
      setIsActive(stockLocation.isActive);
      setHoldsCommittedStock(stockLocation.holdsCommittedStock === true);
    } else {
      setForm({
        code: "",
        name: "",
        description: "",
        parentId: "",
        locationType: "STOCK",
        squareFootage: "",
        locationAliases: "",
        moveMode: "",
      });
      setIsActive(true);
      setHoldsCommittedStock(false);
    }
  }, [stockLocation]);

  // A place cannot be inside itself, anything inside it, or an inactive place.
  const excluded = stockLocation
    ? new Set([stockLocation.id, ...descendantIds(places, stockLocation.id)])
    : new Set<number>();
  const insideOptions = treeOrder(places.filter((p) => p.isActive)).filter(
    ({ place }) => !excluded.has(place.id),
  );

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
          parentId: form.parentId ? Number(form.parentId) : null,
          locationType: form.locationType,
          // Any place can be measured (the space report counts each unit
          // toward its nearest measured place). This was sent only for floor
          // places, so saving any other place wiped its square footage.
          squareFootage: form.squareFootage ? Number.parseInt(form.squareFootage) : null,
          locationAliases: form.locationAliases
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          isActive,
          holdsCommittedStock,
          moveMode: form.moveMode || null,
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
      <div>
        <label htmlFor="stock-location-inside" className="block text-sm text-brand-gray mb-1">
          Inside
        </label>
        <select
          id="stock-location-inside"
          value={form.parentId}
          onChange={(e) => handleChange("parentId", e.target.value)}
          className="w-full border border-brand-gray/30 rounded px-3 py-2 text-sm"
        >
          <option value="">Nothing: at the top of the store</option>
          {insideOptions.map(({ place, depth }) => (
            <option key={place.id} value={place.id}>
              {`${"\u00a0\u00a0".repeat(depth)}${place.code} - ${place.name}`}
            </option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm text-brand-gray mb-1">Location Type</label>
          <select
            value={form.locationType}
            onChange={(e) => handleChange("locationType", e.target.value)}
            className="w-full border border-brand-gray/30 rounded px-3 py-2 text-sm"
          >
            {STOCK_LOCATION_TYPES.map((type) => (
              <option key={type} value={type}>
                {LOCATION_TYPE_INFO[type].label}
                {LOCATION_TYPE_INFO[type].sellable ? "" : " (not for sale)"}
              </option>
            ))}
          </select>
        </div>
        <FormInput
          label="Square Footage"
          name="squareFootage"
          type="number"
          value={form.squareFootage}
          onChange={(v) => handleChange("squareFootage", v)}
        />
      </div>
      <div>
        <label htmlFor="stock-location-move-mode" className="block text-sm text-brand-gray mb-1">
          Moves in and out
        </label>
        <select
          id="stock-location-move-mode"
          value={form.moveMode}
          onChange={(e) => handleChange("moveMode", e.target.value)}
          className="w-full border border-brand-gray/30 rounded px-3 py-2 text-sm"
        >
          <option value="">As its store says</option>
          <option value="QUICK">Quick: move in one step</option>
          <option value="TRACKED">Tracked: a transfer, received at the other end</option>
        </select>
      </div>
      <div>
        <FormInput
          label="Location Aliases"
          name="locationAliases"
          value={form.locationAliases}
          onChange={(v) => handleChange("locationAliases", v)}
          placeholder="Comma-separated external location names"
        />
        <p className="text-[10px] text-brand-gray mt-0.5">
          External location names that map to this USL during import (e.g. &quot;Showroom Mezzanine,
          Back Stockroom&quot;)
        </p>
      </div>
      <div>
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="slHoldsCommittedStock"
            checked={holdsCommittedStock}
            onChange={(e) => setHoldsCommittedStock(e.target.checked)}
            className="rounded"
          />
          <label htmlFor="slHoldsCommittedStock" className="text-sm text-brand-gray">
            Holds stock committed to customers
          </label>
        </div>
        <p className="text-[10px] text-brand-gray mt-0.5">
          Stock here is on hand but already sold — it stays out of available-to-sell quantities and
          shows as Cust Stock on the Buyers Report.
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
          <label htmlFor="slIsActive" className="text-sm text-brand-gray">
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
