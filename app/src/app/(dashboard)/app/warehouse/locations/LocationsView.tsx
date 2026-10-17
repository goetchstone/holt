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
import { isStockLocationType, LOCATION_TYPE_INFO } from "@/lib/inventory/locationTypes";
import { LANDING_PLACES, landingAllows, type LandingPlace } from "@/lib/inventory/landingPlaces";
import { treeOrder } from "@/lib/inventory/placeTree";

interface StockLocationItem {
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
  pickupStockLocationId: number | null;
  returnsStockLocationId: number | null;
  quarantineStockLocationId: number | null;
  transitStockLocationId: number | null;
  fulfilmentStoreLocationId: number | null;
  moveMode: string | null;
}

const LOCATION_TYPES = ["STORE", "WAREHOUSE", "OFFSITE"];

const TYPE_LABELS: Record<string, string> = {
  STORE: "Store",
  WAREHOUSE: "Warehouse",
  OFFSITE: "Offsite",
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

  // One store setting at a time (a landing place, the fulfilment store, the
  // move mode). The server checks each place is at this store and of a type
  // the setting allows, and says which when it is not.
  const handleStoreSettingChange = async (
    locId: number,
    field: string,
    value: number | string | null,
    label: string,
  ) => {
    try {
      await axios.put(`/api/warehouse/locations/${locId}`, { [field]: value });
      toast.success(`${label} updated`);
      fetchLocations();
    } catch (err) {
      toast.error(getErrorMessage(err, `Failed to update ${label.toLowerCase()}`));
    }
  };

  // The place's label: its barcode L-<id> is what a handheld scans back to it.
  const printPlaceLabel = async (placeId: number, name: string) => {
    try {
      await axios.post(`/api/warehouse/stock-locations/${placeId}/label`, {});
      toast.success(`Label for ${name} sent to the printer`);
    } catch (err) {
      toast.error(getErrorMessage(err, "The label was not printed"));
    }
  };

  return (
    <div className="py-2 space-y-6 font-serif">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl text-brand-blue font-semibold">Locations</h1>
        <Button size="sm" onClick={openCreate}>
          Add Location
        </Button>
      </div>

      {/* Store Location Form */}
      {showForm && (
        <div className="bg-white rounded-lg border border-brand-gray/20 shadow-md p-6 space-y-4">
          <h2 className="text-lg font-semibold text-brand-black">
            {editingId ? "Edit Location" : "New Location"}
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label htmlFor="location-name" className="block text-sm text-brand-gray mb-1">
                Name
              </label>
              <input
                id="location-name"
                type="text"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                className="w-full border border-brand-gray/30 rounded px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="location-code" className="block text-sm text-brand-gray mb-1">
                Code
              </label>
              <input
                id="location-code"
                type="text"
                value={form.code}
                onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
                className="w-full border border-brand-gray/30 rounded px-3 py-2 text-sm"
                maxLength={5}
              />
            </div>
            <div>
              <label htmlFor="location-type" className="block text-sm text-brand-gray mb-1">
                Type
              </label>
              <select
                id="location-type"
                value={form.type}
                onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
                className="w-full border border-brand-gray/30 rounded px-3 py-2 text-sm"
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
              <label htmlFor="location-address" className="block text-sm text-brand-gray mb-1">
                Address
              </label>
              <input
                id="location-address"
                type="text"
                value={form.address}
                onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
                className="w-full border border-brand-gray/30 rounded px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="location-city" className="block text-sm text-brand-gray mb-1">
                City
              </label>
              <input
                id="location-city"
                type="text"
                value={form.city}
                onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))}
                className="w-full border border-brand-gray/30 rounded px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="location-state" className="block text-sm text-brand-gray mb-1">
                State
              </label>
              <input
                id="location-state"
                type="text"
                value={form.state}
                onChange={(e) => setForm((f) => ({ ...f, state: e.target.value }))}
                className="w-full border border-brand-gray/30 rounded px-3 py-2 text-sm"
                maxLength={2}
              />
            </div>
            <div>
              <label htmlFor="location-zip" className="block text-sm text-brand-gray mb-1">
                ZIP
              </label>
              <input
                id="location-zip"
                type="text"
                value={form.zip}
                onChange={(e) => setForm((f) => ({ ...f, zip: e.target.value }))}
                className="w-full border border-brand-gray/30 rounded px-3 py-2 text-sm"
                maxLength={10}
              />
            </div>
          </div>

          <div>
            <label htmlFor="location-external-name" className="block text-sm text-brand-gray mb-1">
              the POS Location Name
            </label>
            <input
              id="location-external-name"
              type="text"
              value={form.externalLocationName}
              onChange={(e) => setForm((f) => ({ ...f, externalLocationName: e.target.value }))}
              className="w-full border border-brand-gray/30 rounded px-3 py-2 text-sm"
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
              <label htmlFor="isActive" className="text-sm text-brand-gray">
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
        <p className="text-brand-gray">Loading...</p>
      ) : (
        <div className="space-y-3">
          {locations.map((loc) => (
            <div
              key={loc.id}
              className="bg-white rounded-lg border border-brand-gray/20 shadow-md overflow-hidden"
            >
              {/* Location header row */}
              <div
                className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-brand-stripe/50"
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
                  <span className="text-brand-black font-medium">{loc.name}</span>
                  <span className="text-xs px-1.5 py-0.5 rounded bg-brand-gray/10 text-brand-gray">
                    {loc.code}
                  </span>
                  <span className="text-xs text-brand-gray">
                    {TYPE_LABELS[loc.type] || loc.type}
                  </span>
                  {!loc.isActive && (
                    <span className="text-xs px-2 py-0.5 rounded bg-brand-gray/20 text-brand-gray">
                      Inactive
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm text-brand-gray">
                    {loc.stockLocations.length} USL{loc.stockLocations.length !== 1 ? "s" : ""}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      openEdit(loc);
                    }}
                    className="text-xs text-brand-gray hover:text-brand-blue"
                  >
                    Edit
                  </button>
                  <span className="text-brand-gray text-xs">
                    {expandedId === loc.id ? "▼" : "▶"}
                  </span>
                </div>
              </div>

              {/* Expanded stock locations */}
              {expandedId === loc.id && (
                <div className="border-t border-brand-gray/10 px-4 py-3">
                  {/* Where stock lands at this store, and where its orders draw from */}
                  <div className="mb-4 grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2">
                    {(Object.keys(LANDING_PLACES) as LandingPlace[]).map((kind) => {
                      const info = LANDING_PLACES[kind];
                      const selectId = `landing-${kind}-${loc.id}`;
                      return (
                        <div key={kind} className="flex items-center gap-3">
                          <label
                            htmlFor={selectId}
                            className="text-sm text-brand-gray w-36 shrink-0"
                          >
                            {info.setting}:
                          </label>
                          <select
                            id={selectId}
                            value={loc[info.pointer] ?? ""}
                            onChange={(e) =>
                              handleStoreSettingChange(
                                loc.id,
                                info.pointer,
                                e.target.value ? Number.parseInt(e.target.value) : null,
                                info.setting,
                              )
                            }
                            className="border border-brand-gray/30 rounded px-2 py-1 text-sm min-w-0 flex-1"
                          >
                            <option value="">
                              {info.create
                                ? `Created when first needed (${info.create.name})`
                                : "None"}
                            </option>
                            {loc.stockLocations
                              .filter((sl) => sl.isActive)
                              .filter((sl) => landingAllows(info, sl.locationType))
                              .map((sl) => (
                                <option key={sl.id} value={sl.id}>
                                  {sl.code} - {sl.name}
                                </option>
                              ))}
                          </select>
                        </div>
                      );
                    })}
                    <div className="flex items-center gap-3">
                      <label
                        htmlFor={`fulfilment-${loc.id}`}
                        className="text-sm text-brand-gray w-36 shrink-0"
                      >
                        Also draws from:
                      </label>
                      <select
                        id={`fulfilment-${loc.id}`}
                        value={loc.fulfilmentStoreLocationId ?? ""}
                        onChange={(e) =>
                          handleStoreSettingChange(
                            loc.id,
                            "fulfilmentStoreLocationId",
                            e.target.value ? Number.parseInt(e.target.value) : null,
                            "Fulfilment store",
                          )
                        }
                        className="border border-brand-gray/30 rounded px-2 py-1 text-sm min-w-0 flex-1"
                      >
                        <option value="">Only its own stock</option>
                        {locations
                          .filter((other) => other.id !== loc.id && other.isActive)
                          .map((other) => (
                            <option key={other.id} value={other.id}>
                              {other.name}
                            </option>
                          ))}
                      </select>
                    </div>
                    <div className="flex items-center gap-3">
                      <label
                        htmlFor={`move-mode-${loc.id}`}
                        className="text-sm text-brand-gray w-36 shrink-0"
                      >
                        Moves:
                      </label>
                      <select
                        id={`move-mode-${loc.id}`}
                        value={loc.moveMode ?? ""}
                        onChange={(e) =>
                          handleStoreSettingChange(
                            loc.id,
                            "moveMode",
                            e.target.value || null,
                            "Move mode",
                          )
                        }
                        className="border border-brand-gray/30 rounded px-2 py-1 text-sm min-w-0 flex-1"
                      >
                        <option value="">Default (quick within, tracked between stores)</option>
                        <option value="QUICK">Quick: move in one step</option>
                        <option value="TRACKED">
                          Tracked: a transfer, received at the other end
                        </option>
                      </select>
                    </div>
                  </div>

                  {loc.stockLocations.length === 0 ? (
                    <p className="text-sm text-brand-gray py-2">No stock locations configured</p>
                  ) : (
                    // Places contain places: each shown inside the one it sits in.
                    <div className="space-y-0.5">
                      {treeOrder(loc.stockLocations).map(({ place: sl, depth }) => (
                        <div
                          key={sl.id}
                          style={{ paddingLeft: `${depth * 1.25 + 0.5}rem` }}
                          className="flex items-center gap-2 pr-2 py-1.5 rounded hover:bg-brand-stripe/50 text-sm group"
                        >
                          <span className="text-xs font-mono text-brand-gray w-[110px] shrink-0">
                            {sl.code}
                          </span>
                          <span
                            className={`text-brand-black ${!sl.isActive ? "line-through opacity-50" : ""} ${sl.locationType === "GROUP" ? "font-medium" : ""}`}
                          >
                            {sl.name}
                          </span>
                          <span
                            className={`text-[10px] px-1.5 py-0.5 rounded ${
                              sl.locationType === "FLOOR"
                                ? "bg-blue-50 text-blue-700"
                                : "bg-brand-gray/10 text-brand-gray"
                            }`}
                          >
                            {isStockLocationType(sl.locationType)
                              ? LOCATION_TYPE_INFO[sl.locationType].label
                              : sl.locationType}
                          </span>
                          {sl.squareFootage != null && sl.squareFootage > 0 && (
                            <span className="text-[10px] text-brand-gray">
                              {sl.squareFootage.toLocaleString()} sqft
                            </span>
                          )}
                          <button
                            onClick={() => printPlaceLabel(sl.id, sl.name)}
                            className="text-xs text-brand-gray hover:text-brand-blue opacity-0 group-hover:opacity-100 ml-auto"
                          >
                            Label
                          </button>
                          <button
                            onClick={() =>
                              setStockModal({
                                stockLocation: sl,
                                storeLocationId: loc.id,
                              })
                            }
                            className="text-xs text-brand-gray hover:text-brand-blue opacity-0 group-hover:opacity-100"
                          >
                            Edit
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="mt-3 pt-3 border-t border-brand-gray/10">
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
            <p className="text-brand-gray text-center py-8">No locations configured</p>
          )}
        </div>
      )}

      {/* Stock Location Modal */}
      {stockModal && (
        <StockLocationModal
          stockLocation={stockModal.stockLocation}
          storeLocationId={stockModal.storeLocationId}
          places={locations.find((l) => l.id === stockModal.storeLocationId)?.stockLocations ?? []}
          onClose={() => setStockModal(null)}
          onRefresh={fetchLocations}
        />
      )}
    </div>
  );
}
