"use client";

// /app/src/app/(dashboard)/app/warehouse/transfers/new/NewTransferView.tsx
//
// New transfer body (product search + from/to location selectors + qty/notes).
// App Router port of the legacy pages/warehouse/transfers/new.tsx body (minus
// MainLayout chrome, which comes from the (dashboard) layout). Reads the shared
// /api/warehouse/locations + /api/warehouse/transfers REST endpoints.

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import axios from "axios";
import { toast } from "react-toastify";
import { getErrorMessage } from "@/lib/toastError";
import { Button } from "@/components/ui/button";
import { useProductSearch } from "@/hooks/useProductSearch";

interface StockLocationOption {
  id: number;
  code: string;
  name: string;
}

interface LocationOption {
  id: number;
  name: string;
  code: string;
  stockLocations: StockLocationOption[];
}

export function NewTransferView() {
  const router = useRouter();
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const {
    query: productSearch,
    setQuery: setProductSearch,
    results: productResults,
    isSearching: searching,
    clear: clearProductSearch,
  } = useProductSearch({ limit: 10 });
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState({
    productId: null as number | null,
    productDisplay: "",
    fromLocationId: "",
    fromStockLocationId: "",
    toLocationId: "",
    toStockLocationId: "",
    quantity: 1,
    notes: "",
  });

  useEffect(() => {
    axios.get("/api/warehouse/locations").then((res) => {
      setLocations(res.data.locations.filter((l: LocationOption) => l.id));
    });
  }, []);

  const selectProduct = (p: { id: number; name: string; productNumber: string }) => {
    setForm((f) => ({
      ...f,
      productId: p.id,
      productDisplay: `${p.name} (${p.productNumber})`,
    }));
    clearProductSearch();
  };

  const fromLocation = locations.find((l) => l.id === Number.parseInt(form.fromLocationId));
  const toLocation = locations.find((l) => l.id === Number.parseInt(form.toLocationId));

  const handleSubmit = async () => {
    if (!form.productId) {
      toast.error("Select a product");
      return;
    }
    if (!form.fromLocationId || !form.toLocationId) {
      toast.error("Select from and to locations");
      return;
    }
    if (
      form.fromLocationId === form.toLocationId &&
      form.fromStockLocationId === form.toStockLocationId
    ) {
      toast.error("From and to must be different");
      return;
    }

    setSaving(true);
    try {
      const res = await axios.post("/api/warehouse/transfers", {
        productId: form.productId,
        fromLocationId: Number.parseInt(form.fromLocationId),
        fromStockLocationId: form.fromStockLocationId
          ? Number.parseInt(form.fromStockLocationId)
          : null,
        toLocationId: Number.parseInt(form.toLocationId),
        toStockLocationId: form.toStockLocationId ? Number.parseInt(form.toStockLocationId) : null,
        quantity: form.quantity,
        notes: form.notes || null,
      });
      toast.success("Transfer created");
      router.push(`/app/warehouse/transfers/${res.data.id}`);
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, "Failed to create transfer"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="py-2 space-y-6 font-serif">
      <h1 className="text-2xl text-sh-blue font-semibold">New Transfer</h1>

      <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-6 space-y-5">
        {/* Product search */}
        <div className="relative">
          <label htmlFor="transfer-product-search" className="block text-sm text-sh-gray mb-1">
            Product
          </label>
          {form.productId ? (
            <div className="flex items-center gap-2">
              <span className="text-sh-black">{form.productDisplay}</span>
              <button
                onClick={() => setForm((f) => ({ ...f, productId: null, productDisplay: "" }))}
                className="text-xs text-sh-gray hover:text-red-600"
              >
                Clear
              </button>
            </div>
          ) : (
            <div>
              <input
                id="transfer-product-search"
                type="text"
                value={productSearch}
                onChange={(e) => setProductSearch(e.target.value)}
                placeholder="Search by name or product number..."
                className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
              />
              {(productResults.length > 0 || searching) && (
                <div className="absolute z-10 mt-1 w-full bg-white border border-sh-gray/20 rounded shadow-lg max-h-48 overflow-y-auto">
                  {searching ? (
                    <div className="px-3 py-2 text-sm text-sh-gray">Searching...</div>
                  ) : (
                    productResults.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => selectProduct(p)}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-sh-stripe border-b border-sh-gray/10"
                      >
                        <span className="text-sh-black">{p.name}</span>
                        <span className="text-sh-gray ml-2">{p.productNumber}</span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* From / To */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          <div className="space-y-3">
            <h3 className="text-sm font-medium text-sh-black">From</h3>
            <div>
              <label htmlFor="transfer-from-location" className="block text-xs text-sh-gray mb-1">
                Location
              </label>
              <select
                id="transfer-from-location"
                value={form.fromLocationId}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    fromLocationId: e.target.value,
                    fromStockLocationId: "",
                  }))
                }
                className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
              >
                <option value="">Select location...</option>
                {locations.map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    {loc.name}
                  </option>
                ))}
              </select>
            </div>
            {fromLocation && fromLocation.stockLocations.length > 0 && (
              <div>
                <label
                  htmlFor="transfer-from-stock-location"
                  className="block text-xs text-sh-gray mb-1"
                >
                  Stock Location
                </label>
                <select
                  id="transfer-from-stock-location"
                  value={form.fromStockLocationId}
                  onChange={(e) => setForm((f) => ({ ...f, fromStockLocationId: e.target.value }))}
                  className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
                >
                  <option value="">Any stock location</option>
                  {fromLocation.stockLocations.map((sl) => (
                    <option key={sl.id} value={sl.id}>
                      {sl.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div className="space-y-3">
            <h3 className="text-sm font-medium text-sh-black">To</h3>
            <div>
              <label htmlFor="transfer-to-location" className="block text-xs text-sh-gray mb-1">
                Location
              </label>
              <select
                id="transfer-to-location"
                value={form.toLocationId}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    toLocationId: e.target.value,
                    toStockLocationId: "",
                  }))
                }
                className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
              >
                <option value="">Select location...</option>
                {locations.map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    {loc.name}
                  </option>
                ))}
              </select>
            </div>
            {toLocation && toLocation.stockLocations.length > 0 && (
              <div>
                <label
                  htmlFor="transfer-to-stock-location"
                  className="block text-xs text-sh-gray mb-1"
                >
                  Stock Location
                </label>
                <select
                  id="transfer-to-stock-location"
                  value={form.toStockLocationId}
                  onChange={(e) => setForm((f) => ({ ...f, toStockLocationId: e.target.value }))}
                  className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
                >
                  <option value="">Any stock location</option>
                  {toLocation.stockLocations.map((sl) => (
                    <option key={sl.id} value={sl.id}>
                      {sl.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </div>

        {/* Quantity and notes */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="transfer-quantity" className="block text-sm text-sh-gray mb-1">
              Quantity
            </label>
            <input
              id="transfer-quantity"
              type="number"
              min={1}
              value={form.quantity}
              onChange={(e) =>
                setForm((f) => ({ ...f, quantity: Number.parseInt(e.target.value) || 1 }))
              }
              className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label htmlFor="transfer-notes" className="block text-sm text-sh-gray mb-1">
              Notes
            </label>
            <input
              id="transfer-notes"
              type="text"
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
              placeholder="Optional"
            />
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-3 pt-2">
          <Button size="sm" onClick={handleSubmit} disabled={saving}>
            {saving ? "Creating..." : "Create Transfer"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => router.push("/app/warehouse/transfers")}
          >
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
