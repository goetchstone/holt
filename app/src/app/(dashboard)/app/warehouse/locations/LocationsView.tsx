"use client";

// /app/src/app/(dashboard)/app/warehouse/locations/LocationsView.tsx
//
// Locations body (store locations with expandable stock locations + default
// receiving location selector + create/edit form). App Router port of the legacy
// pages/warehouse/locations.tsx body (minus MainLayout chrome, which comes from
// the (dashboard) layout). Reads the shared /api/warehouse/locations REST
// endpoint.

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import axios from "axios";
import { toast } from "react-toastify";
import { getErrorMessage } from "@/lib/toastError";
import StockLocationModal from "@/components/modals/StockLocationModal";

interface StockLocationItem {
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
  sortOrder: number;
}

interface StoreLocation {
  id: number;
  name: string;
  code: string;
  type: string;
  stockLocations: StockLocationItem[];
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  isActive: boolean;
  sortOrder: number;
  externalLocationName: string | null;
  defaultReceivingStockLocationId: number | null;
}

const LOCATION_TYPES = ["STORE", "WAREHOUSE", "OFFSITE"];

const TYPE_LABELS: Record<string, string> = {
  STORE: "Store",
  WAREHOUSE: "Warehouse",
  OFFSITE: "Offsite",
};

const FLOOR_LABELS: Record<number, string> = {
  0: "Basement",
  1: "1st Floor",
  2: "2nd Floor",
  3: "Attic",
};

const emptyForm = {
  name: "",
  code: "",
  type: "STORE",
  address: "",
  city: "",
  state: "",
  zip: "",
  externalLocationName: "",
  isActive: true,
};

export function LocationsView() {
  const [locations, setLocations] = useState<StoreLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [stockModal, setStockModal] = useState<{
    stockLocation: StockLocationItem | null;
    storeLocationId: number;
  } | null>(null);

  const fetchLocations = useCallback(async () => {
    try {
      const res = await axios.get("/api/warehouse/locations");
      setLocations(res.data.locations);
    } catch {
      toast.error("Failed to load locations");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLocations();
  }, [fetchLocations]);

  const openCreate = () => {
    setForm(emptyForm);
    setEditingId(null);
    setShowForm(true);
  };

  const openEdit = (loc: StoreLocation) => {
    setForm({
      name: loc.name,
      code: loc.code,
      type: loc.type,
      address: loc.address || "",
      city: loc.city || "",
      state: loc.state || "",
      zip: loc.zip || "",
      externalLocationName: loc.externalLocationName || "",
      isActive: loc.isActive,
    });
    setEditingId(loc.id);
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.name.trim() || !form.code.trim()) {
      toast.error("Name and code are required");
      return;
    }

    setSaving(true);
    try {
      const payload = {
        ...form,
        externalLocationName: form.externalLocationName || null,
        address: form.address || null,
        city: form.city || null,
        state: form.state || null,
        zip: form.zip || null,
      };

      if (editingId) {
        await axios.put(`/api/warehouse/locations/${editingId}`, payload);
        toast.success("Location updated");
      } else {
        await axios.post("/api/warehouse/locations", payload);
        toast.success("Location created");
      }

      setShowForm(false);
      setEditingId(null);
      fetchLocations();
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, "Failed to save location"));
    } finally {
      setSaving(false);
    }
  };

  const toggleExpand = (id: number) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  const groupByBuilding = (items: StockLocationItem[]) => {
    const groups: Record<string, StockLocationItem[]> = {};
    for (const item of items) {
      const key = item.building || "General";
      if (!groups[key]) groups[key] = [];
      groups[key].push(item);
    }
    return groups;
  };

  const handleDefaultReceivingChange = async (locId: number, stockLocationId: number | null) => {
    try {
      await axios.put(`/api/warehouse/locations/${locId}`, {
        defaultReceivingStockLocationId: stockLocationId,
      });
      toast.success("Default receiving location updated");
      fetchLocations();
    } catch {
      toast.error("Failed to update default receiving location");
    }
  };

  return (
    <div className="py-2 space-y-6 font-serif">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl text-sh-blue font-semibold">Locations</h1>
        <Button size="sm" onClick={openCreate}>
          Add Location
        </Button>
      </div>

      {/* Store Location Form */}
      {showForm && (
        <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-6 space-y-4">
          <h2 className="text-lg font-semibold text-sh-black">
            {editingId ? "Edit Location" : "New Location"}
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label htmlFor="location-name" className="block text-sm text-sh-gray mb-1">
                Name
              </label>
              <input
                id="location-name"
                type="text"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="location-code" className="block text-sm text-sh-gray mb-1">
                Code
              </label>
              <input
                id="location-code"
                type="text"
                value={form.code}
                onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
                className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
                maxLength={5}
              />
            </div>
            <div>
              <label htmlFor="location-type" className="block text-sm text-sh-gray mb-1">
                Type
              </label>
              <select
                id="location-type"
                value={form.type}
                onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
                className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
              >
                {LOCATION_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
            <div>
              <label htmlFor="location-address" className="block text-sm text-sh-gray mb-1">
                Address
              </label>
              <input
                id="location-address"
                type="text"
                value={form.address}
                onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
                className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="location-city" className="block text-sm text-sh-gray mb-1">
                City
              </label>
              <input
                id="location-city"
                type="text"
                value={form.city}
                onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))}
                className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="location-state" className="block text-sm text-sh-gray mb-1">
                State
              </label>
              <input
                id="location-state"
                type="text"
                value={form.state}
                onChange={(e) => setForm((f) => ({ ...f, state: e.target.value }))}
                className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
                maxLength={2}
              />
            </div>
            <div>
              <label htmlFor="location-zip" className="block text-sm text-sh-gray mb-1">
                ZIP
              </label>
              <input
                id="location-zip"
                type="text"
                value={form.zip}
                onChange={(e) => setForm((f) => ({ ...f, zip: e.target.value }))}
                className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
                maxLength={10}
              />
            </div>
          </div>

          <div>
            <label htmlFor="location-external-name" className="block text-sm text-sh-gray mb-1">
              the POS Location Name
            </label>
            <input
              id="location-external-name"
              type="text"
              value={form.externalLocationName}
              onChange={(e) => setForm((f) => ({ ...f, externalLocationName: e.target.value }))}
              className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
              placeholder="Maps to the POS stock location strings"
            />
          </div>

          {editingId && (
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="isActive"
                checked={form.isActive}
                onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
                className="rounded"
              />
              <label htmlFor="isActive" className="text-sm text-sh-gray">
                Active
              </label>
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? "Saving..." : editingId ? "Update" : "Create"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setShowForm(false);
                setEditingId(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Location list */}
      {loading ? (
        <p className="text-sh-gray">Loading...</p>
      ) : (
        <div className="space-y-3">
          {locations.map((loc) => (
            <div
              key={loc.id}
              className="bg-white rounded-lg border border-sh-gray/20 shadow-md overflow-hidden"
            >
              {/* Location header row */}
              <div
                className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-sh-stripe/50"
                role="button"
                tabIndex={0}
                onClick={() => toggleExpand(loc.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggleExpand(loc.id);
                  }
                }}
              >
                <div className="flex items-center gap-3">
                  <span className="text-sh-black font-medium">{loc.name}</span>
                  <span className="text-xs px-1.5 py-0.5 rounded bg-sh-gray/10 text-sh-gray">
                    {loc.code}
                  </span>
                  <span className="text-xs text-sh-gray">{TYPE_LABELS[loc.type] || loc.type}</span>
                  {!loc.isActive && (
                    <span className="text-xs px-2 py-0.5 rounded bg-sh-gray/20 text-sh-gray">
                      Inactive
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm text-sh-gray">
                    {loc.stockLocations.length} USL{loc.stockLocations.length !== 1 ? "s" : ""}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      openEdit(loc);
                    }}
                    className="text-xs text-sh-gray hover:text-sh-blue"
                  >
                    Edit
                  </button>
                  <span className="text-sh-gray text-xs">{expandedId === loc.id ? "▼" : "▶"}</span>
                </div>
              </div>

              {/* Expanded stock locations */}
              {expandedId === loc.id && (
                <div className="border-t border-sh-gray/10 px-4 py-3">
                  {/* Default receiving location */}
                  <div className="mb-4 flex items-center gap-3">
                    <label
                      htmlFor={`default-receiving-${loc.id}`}
                      className="text-sm text-sh-gray whitespace-nowrap"
                    >
                      Default Receiving Location:
                    </label>
                    <select
                      id={`default-receiving-${loc.id}`}
                      value={loc.defaultReceivingStockLocationId || ""}
                      onChange={(e) =>
                        handleDefaultReceivingChange(
                          loc.id,
                          e.target.value ? Number.parseInt(e.target.value) : null,
                        )
                      }
                      className="border border-sh-gray/30 rounded px-2 py-1 text-sm"
                    >
                      <option value="">None</option>
                      {loc.stockLocations
                        .filter((sl) => sl.isActive)
                        .map((sl) => (
                          <option key={sl.id} value={sl.id}>
                            {sl.code} - {sl.name}
                          </option>
                        ))}
                    </select>
                  </div>

                  {loc.stockLocations.length === 0 ? (
                    <p className="text-sm text-sh-gray py-2">No stock locations configured</p>
                  ) : (
                    <div className="space-y-4">
                      {Object.entries(groupByBuilding(loc.stockLocations)).map(
                        ([building, items]) => (
                          <div key={building}>
                            <h4 className="text-xs font-medium text-sh-gray uppercase tracking-wide mb-2">
                              {building}
                            </h4>
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1">
                              {items.map((sl) => (
                                <div
                                  key={sl.id}
                                  className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-sh-stripe/50 text-sm group"
                                >
                                  <span className="text-xs font-mono text-sh-gray w-[90px] shrink-0">
                                    {sl.code}
                                  </span>
                                  <span
                                    className={`text-sh-black ${!sl.isActive ? "line-through opacity-50" : ""}`}
                                  >
                                    {sl.name}
                                  </span>
                                  <span
                                    className={`text-[10px] px-1.5 py-0.5 rounded ${
                                      sl.locationType === "FLOOR"
                                        ? "bg-blue-50 text-blue-700"
                                        : "bg-sh-gray/10 text-sh-gray"
                                    }`}
                                  >
                                    {sl.locationType === "FLOOR" ? "Floor" : "Stock"}
                                  </span>
                                  {sl.locationType === "FLOOR" && sl.squareFootage && (
                                    <span className="text-[10px] text-sh-gray">
                                      {sl.squareFootage.toLocaleString()} sqft
                                    </span>
                                  )}
                                  {sl.floor != null && (
                                    <span className="text-xs text-sh-gray">
                                      {FLOOR_LABELS[sl.floor] || `Floor ${sl.floor}`}
                                    </span>
                                  )}
                                  <button
                                    onClick={() =>
                                      setStockModal({
                                        stockLocation: sl,
                                        storeLocationId: loc.id,
                                      })
                                    }
                                    className="text-xs text-sh-gray hover:text-sh-blue opacity-0 group-hover:opacity-100 ml-auto"
                                  >
                                    Edit
                                  </button>
                                </div>
                              ))}
                            </div>
                          </div>
                        ),
                      )}
                    </div>
                  )}

                  <div className="mt-3 pt-3 border-t border-sh-gray/10">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setStockModal({ stockLocation: null, storeLocationId: loc.id })
                      }
                    >
                      Add Stock Location
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ))}
          {locations.length === 0 && (
            <p className="text-sh-gray text-center py-8">No locations configured</p>
          )}
        </div>
      )}

      {/* Stock Location Modal */}
      {stockModal && (
        <StockLocationModal
          stockLocation={stockModal.stockLocation}
          storeLocationId={stockModal.storeLocationId}
          onClose={() => setStockModal(null)}
          onRefresh={fetchLocations}
        />
      )}
    </div>
  );
}
