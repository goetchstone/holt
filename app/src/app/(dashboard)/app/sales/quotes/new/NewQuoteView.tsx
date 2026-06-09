"use client";

// /app/src/app/(dashboard)/app/sales/quotes/new/NewQuoteView.tsx
//
// New Quote builder. App Router port of the legacy sales/quotes/new body (minus
// MainLayout chrome, which the (dashboard) layout supplies). Reads + writes the
// shared REST endpoints (/api/warehouse/locations, /api/customers/:id,
// /api/sales/orders/create-from-cart, /api/interactions/:id), which stay REST.
// Customer + product search hooks, configurator hand-off via sessionStorage,
// and line-item builder preserved verbatim.

import { useState, useEffect } from "react";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { toast } from "react-toastify";
import { useRouter, useSearchParams } from "next/navigation";
import { useActiveStore } from "@/hooks/useActiveStore";
import { useCustomerSearch, type CustomerSearchResult } from "@/hooks/useCustomerSearch";
import { useProductSearch } from "@/hooks/useProductSearch";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";

type ItemSource = "FLOOR" | "ORDER";
type FulfillmentMethod = "TAKE" | "PICKUP" | "DELIVERY";

interface QuoteLineItem {
  id: string;
  type: "PRODUCT" | "CONFIGURED" | "CUSTOM";
  productId: number | null;
  productNumber: string;
  name: string;
  description: string;
  price: number;
  cost: number;
  quantity: number;
  vendor: string;
  source: ItemSource;
  fulfillment: FulfillmentMethod;
  pickLocationId: number | null;
}

interface StoreLocationOption {
  id: number;
  name: string;
  type: string;
}

interface CustomerAddress {
  id: number;
  address1: string;
  address2: string | null;
  city: string;
  state: string;
  zip: string;
}

// Extends the base search result with address data returned by the API.
interface CustomerWithAddresses extends CustomerSearchResult {
  addresses: CustomerAddress[];
}

let lineCounter = 0;
function nextLineId(): string {
  lineCounter += 1;
  return `line-${lineCounter}`;
}

export function NewQuoteView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const fmt = useMoneyFormatter();
  const { activeStore } = useActiveStore();
  const [lines, setLines] = useState<QuoteLineItem[]>([]);

  // Customer
  const {
    query: customerSearch,
    setQuery: setCustomerSearch,
    results: customerResults,
    clear: clearCustomerSearch,
  } = useCustomerSearch({ limit: 5 });
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerWithAddresses | null>(null);

  // Product search
  const {
    query: productSearch,
    setQuery: setProductSearch,
    results: productResults,
    clear: clearProductSearch,
  } = useProductSearch();

  // Custom line item
  const [showCustomForm, setShowCustomForm] = useState(false);
  const [customForm, setCustomForm] = useState({
    name: "",
    description: "",
    price: "",
    quantity: "1",
  });

  // Store locations for pick-from dropdown
  const [storeLocations, setStoreLocations] = useState<StoreLocationOption[]>([]);
  useEffect(() => {
    fetch("/api/warehouse/locations")
      .then((r) => r.json())
      .then((data) => {
        const locs = (data || []).map((l: StoreLocationOption) => ({
          id: l.id,
          name: l.name,
          type: l.type,
        }));
        setStoreLocations(locs);
      })
      .catch(() => {});
  }, []);

  // Notes
  const [orderNotes, setOrderNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Pre-populate customer from URL query param (e.g. linked from an interaction)
  useEffect(() => {
    const qCustomerId = searchParams?.get("customerId");
    if (!qCustomerId || selectedCustomer) return;
    const cid = Number.parseInt(qCustomerId, 10);
    if (Number.isNaN(cid)) return;

    fetch(`/api/customers/${cid}`)
      .then((r) => {
        if (!r.ok) throw new Error("not found");
        return r.json();
      })
      .then((c) => setSelectedCustomer(c as CustomerWithAddresses))
      .catch(() => {});
    // Only run when query params become available
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Restore quote state and pick up configured items from sessionStorage
  useEffect(() => {
    const pending = sessionStorage.getItem("pendingQuote");
    if (pending) {
      try {
        const state = JSON.parse(pending);
        if (Array.isArray(state.lines) && state.lines.length > 0) setLines(state.lines);
        if (state.selectedCustomer) setSelectedCustomer(state.selectedCustomer);
        if (state.orderNotes) setOrderNotes(state.orderNotes);
      } catch {
        // corrupt data, ignore
      }
      sessionStorage.removeItem("pendingQuote");
    }

    const configured = sessionStorage.getItem("configuredItem");
    if (configured) {
      try {
        const item = JSON.parse(configured);
        setLines((prev) => [
          ...prev,
          {
            id: nextLineId(),
            type: "CONFIGURED" as const,
            productId: item.productId ?? null,
            productNumber: item.productNumber || "",
            name: item.name || item.productNumber || "",
            description: item.description || "",
            price: Number(item.price) || 0,
            cost: Number(item.cost) || 0,
            quantity: 1,
            vendor: item.vendor || "",
            source: "ORDER" as ItemSource,
            fulfillment: "DELIVERY" as FulfillmentMethod,
            pickLocationId: null,
          },
        ]);
      } catch {
        // corrupt data, ignore
      }
      sessionStorage.removeItem("configuredItem");
    }
  }, []);

  const openConfigurator = () => {
    sessionStorage.setItem(
      "pendingQuote",
      JSON.stringify({
        lines,
        selectedCustomer,
        orderNotes,
      }),
    );
    router.push("/app/tools/configurator?returnTo=quote");
  };

  const total = lines.reduce((sum, l) => sum + l.price * l.quantity, 0);

  const addProduct = (p: {
    id: number;
    productNumber: string;
    name: string;
    baseRetail?: number | null;
    baseCost?: number | null;
    vendorName?: string;
  }) => {
    const price = p.baseRetail ? Number(p.baseRetail) : p.baseCost ? Number(p.baseCost) * 2.5 : 0;

    setLines([
      ...lines,
      {
        id: nextLineId(),
        type: "PRODUCT",
        productId: p.id,
        productNumber: p.productNumber,
        name: p.name || p.productNumber,
        description: "",
        price,
        cost: p.baseCost ? Number(p.baseCost) : 0,
        quantity: 1,
        vendor: p.vendorName || "",
        source: "FLOOR" as ItemSource,
        fulfillment: "TAKE" as FulfillmentMethod,
        pickLocationId: activeStore?.id ?? null,
      },
    ]);
    clearProductSearch();
  };

  const addCustomLine = () => {
    const price = Number.parseFloat(customForm.price);
    const qty = Number.parseInt(customForm.quantity) || 1;
    if (!customForm.name.trim() || Number.isNaN(price) || price <= 0) {
      toast.error("Name and valid price are required");
      return;
    }
    setLines([
      ...lines,
      {
        id: nextLineId(),
        type: "CUSTOM",
        productId: null,
        productNumber: "CUSTOM",
        name: customForm.name.trim(),
        description: customForm.description.trim(),
        price,
        cost: 0,
        quantity: qty,
        vendor: "",
        source: "ORDER" as ItemSource,
        fulfillment: "DELIVERY" as FulfillmentMethod,
        pickLocationId: null,
      },
    ]);
    setCustomForm({ name: "", description: "", price: "", quantity: "1" });
    setShowCustomForm(false);
  };

  const removeLine = (id: string) => {
    setLines(lines.filter((l) => l.id !== id));
  };

  const updateLine = (id: string, updates: Partial<QuoteLineItem>) => {
    setLines(lines.map((l) => (l.id === id ? { ...l, ...updates } : l)));
  };

  const handleCreateQuote = async () => {
    if (lines.length === 0) {
      toast.error("Add at least one item to the quote");
      return;
    }

    setSubmitting(true);
    try {
      const res = await axios.post("/api/sales/orders/create-from-cart", {
        customerId: selectedCustomer?.id || null,
        storeLocation: activeStore?.name || null,
        orderNotes: orderNotes.trim() || null,
        items: lines.map((l) => ({
          type: l.type,
          productId: l.productId || undefined,
          productNumber: l.productNumber || undefined,
          quantity: l.quantity,
          unitPrice: l.price,
          cost: l.cost || undefined,
          name: l.name,
          description: l.description,
          vendor: l.vendor || undefined,
          source: l.source,
          fulfillment: l.fulfillment,
          pickLocationId: l.pickLocationId || undefined,
        })),
      });
      // Link the interaction to the new sales order if created from one
      const qInteractionId = searchParams?.get("interactionId");
      if (qInteractionId) {
        const iid = Number.parseInt(qInteractionId, 10);
        if (!Number.isNaN(iid)) {
          await axios
            .put(`/api/interactions/${iid}`, {
              salesOrderId: res.data.id,
              outcome: "QUOTE",
            })
            .catch(() => {});
        }
      }

      toast.success(`Quote ${res.data.orderno} created`);
      router.push(`/app/sales/orders/${res.data.id}`);
    } catch (err: unknown) {
      const msg =
        axios.isAxiosError(err) && err.response?.data?.error
          ? err.response.data.error
          : "Failed to create quote";
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto py-4 font-serif">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-semibold text-sh-blue">New Quote</h1>
        <Button variant="outline" onClick={() => router.push("/app/sales/orders")}>
          Cancel
        </Button>
      </div>

      {/* Customer */}
      <div className="bg-white border border-sh-gray/20 rounded-lg shadow-sm p-4 mb-4">
        <p className="text-xs text-sh-gray mb-1">Customer</p>
        {selectedCustomer ? (
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm font-medium text-sh-black">
                {selectedCustomer.firstName} {selectedCustomer.lastName}
              </p>
              <p className="text-xs text-sh-gray">
                {[selectedCustomer.email, selectedCustomer.phone].filter(Boolean).join(" | ")}
              </p>
              {selectedCustomer.addresses?.length > 0 && (
                <p className="text-xs text-sh-gray mt-0.5">
                  {selectedCustomer.addresses[0].address1}
                  {selectedCustomer.addresses[0].address2 &&
                    `, ${selectedCustomer.addresses[0].address2}`}
                  {", "}
                  {selectedCustomer.addresses[0].city}, {selectedCustomer.addresses[0].state}{" "}
                  {selectedCustomer.addresses[0].zip}
                </p>
              )}
            </div>
            <button
              onClick={() => setSelectedCustomer(null)}
              className="text-xs text-sh-gray underline"
            >
              Change
            </button>
          </div>
        ) : (
          <div className="relative">
            <input
              type="text"
              value={customerSearch}
              onChange={(e) => setCustomerSearch(e.target.value)}
              placeholder="Search by name, phone, or email..."
              className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm focus:outline-none focus:border-sh-blue"
            />
            {customerResults.length > 0 && (
              <div className="absolute z-10 top-full left-0 right-0 bg-white border border-sh-gray/20 rounded shadow-lg mt-1 max-h-40 overflow-y-auto">
                {(customerResults as CustomerWithAddresses[]).map((c) => (
                  <button
                    key={c.id}
                    onClick={() => {
                      setSelectedCustomer(c);
                      clearCustomerSearch();
                    }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-sh-linen border-b border-sh-gray/10 last:border-0"
                  >
                    <span className="font-medium">
                      {c.firstName} {c.lastName}
                    </span>
                    {c.phone && <span className="text-sh-gray ml-2">{c.phone}</span>}
                    {c.addresses?.length > 0 && (
                      <span className="block text-[10px] text-sh-gray">
                        {c.addresses[0].city}, {c.addresses[0].state} {c.addresses[0].zip}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Add items */}
      <div className="bg-white border border-sh-gray/20 rounded-lg shadow-sm p-4 mb-4 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-sh-black">Add Items</p>
          <div className="flex gap-2">
            <button
              onClick={() => setShowCustomForm(!showCustomForm)}
              className="px-3 py-1.5 text-xs rounded border border-sh-gray/30 text-sh-gray hover:border-sh-blue hover:text-sh-blue transition"
            >
              Custom Item
            </button>
            <button
              onClick={openConfigurator}
              className="px-3 py-1.5 text-xs rounded border border-sh-blue text-sh-blue hover:bg-sh-blue hover:text-white transition"
            >
              Open Configurator
            </button>
          </div>
        </div>

        {/* Product search */}
        <div className="relative">
          <input
            type="text"
            value={productSearch}
            onChange={(e) => setProductSearch(e.target.value)}
            placeholder="Search products by name, part number, or barcode..."
            className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm focus:outline-none focus:border-sh-blue"
          />
          {productResults.length > 0 && (
            <div className="absolute z-10 top-full left-0 right-0 bg-white border border-sh-gray/20 rounded shadow-lg mt-1 max-h-80 overflow-y-auto">
              {productResults.map((p) => (
                <button
                  key={p.id}
                  onClick={() => addProduct(p)}
                  className="w-full text-left px-3 py-2.5 text-sm hover:bg-sh-linen border-b border-sh-gray/10 last:border-0"
                >
                  <div className="flex justify-between items-start">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-sh-black truncate">{p.name}</p>
                      <p className="text-xs text-sh-gray">
                        {p.productNumber}
                        {p.vendorName && <span> -- {p.vendorName}</span>}
                      </p>
                    </div>
                    {p.baseRetail && (
                      <span className="text-sm text-sh-black ml-3">
                        {fmt(Number(p.baseRetail))}
                      </span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Custom line item form */}
        {showCustomForm && (
          <div className="border border-sh-gray/20 rounded p-3 space-y-2 bg-sh-linen">
            <div className="grid grid-cols-2 gap-2">
              <input
                type="text"
                value={customForm.name}
                onChange={(e) => setCustomForm({ ...customForm, name: e.target.value })}
                placeholder="Item name"
                className="border border-sh-gray/30 rounded px-2 py-1.5 text-sm"
              />
              <input
                type="text"
                value={customForm.description}
                onChange={(e) => setCustomForm({ ...customForm, description: e.target.value })}
                placeholder="Description (optional)"
                className="border border-sh-gray/30 rounded px-2 py-1.5 text-sm"
              />
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                step="0.01"
                value={customForm.price}
                onChange={(e) => setCustomForm({ ...customForm, price: e.target.value })}
                placeholder="Price"
                className="w-28 border border-sh-gray/30 rounded px-2 py-1.5 text-sm"
              />
              <input
                type="number"
                min="1"
                value={customForm.quantity}
                onChange={(e) => setCustomForm({ ...customForm, quantity: e.target.value })}
                placeholder="Qty"
                className="w-16 border border-sh-gray/30 rounded px-2 py-1.5 text-sm"
              />
              <Button size="sm" onClick={addCustomLine}>
                Add
              </Button>
              <button
                onClick={() => setShowCustomForm(false)}
                className="text-xs text-sh-gray underline"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Line items */}
      <div className="bg-white border border-sh-gray/20 rounded-lg shadow-sm overflow-hidden mb-4">
        {lines.length === 0 ? (
          <p className="text-sh-gray text-center py-8">Add items to build a quote</p>
        ) : (
          <>
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-sh-linen border-b border-sh-gray/20">
                  <th className="text-left p-3 font-semibold">Item</th>
                  <th className="text-center p-3 font-semibold w-20">Qty</th>
                  <th className="text-right p-3 font-semibold w-28">Price</th>
                  <th className="text-right p-3 font-semibold w-28">Subtotal</th>
                  <th className="w-10"></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.id} className="border-b border-sh-gray/10">
                    <td className="p-3">
                      <p className="text-sh-black font-medium">{line.name}</p>
                      <p className="text-xs text-sh-gray">
                        {line.productNumber !== "CUSTOM" && line.productNumber}
                        {line.vendor && <span> -- {line.vendor}</span>}
                        {line.description && <span> -- {line.description}</span>}
                        {line.type === "CUSTOM" && (
                          <span className="ml-1 px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px]">
                            Custom
                          </span>
                        )}
                        {line.type === "CONFIGURED" && (
                          <span className="ml-1 px-1.5 py-0.5 rounded bg-sh-blue/10 text-sh-blue text-[10px]">
                            Configured
                          </span>
                        )}
                      </p>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <select
                          value={line.source}
                          onChange={(e) => {
                            const source = e.target.value as ItemSource;
                            updateLine(line.id, {
                              source,
                              pickLocationId: source === "ORDER" ? null : line.pickLocationId,
                            });
                          }}
                          className="text-[10px] border border-sh-gray/30 rounded px-1 py-0.5 bg-white"
                        >
                          <option value="FLOOR">Floor Stock</option>
                          <option value="ORDER">Special Order</option>
                        </select>
                        {line.source === "FLOOR" && (
                          <select
                            value={line.pickLocationId ?? ""}
                            onChange={(e) =>
                              updateLine(line.id, {
                                pickLocationId: e.target.value ? Number(e.target.value) : null,
                              })
                            }
                            className="text-[10px] border border-sh-gray/30 rounded px-1 py-0.5 bg-white"
                          >
                            <option value="">Pick from...</option>
                            {storeLocations.map((loc) => (
                              <option key={loc.id} value={loc.id}>
                                {loc.name}
                              </option>
                            ))}
                          </select>
                        )}
                        <select
                          value={line.fulfillment}
                          onChange={(e) =>
                            updateLine(line.id, {
                              fulfillment: e.target.value as FulfillmentMethod,
                            })
                          }
                          className="text-[10px] border border-sh-gray/30 rounded px-1 py-0.5 bg-white"
                        >
                          <option value="TAKE">Customer Take</option>
                          <option value="PICKUP">Pickup</option>
                          <option value="DELIVERY">Delivery</option>
                        </select>
                      </div>
                    </td>
                    <td className="p-3 text-center">
                      <input
                        type="number"
                        min="1"
                        value={line.quantity}
                        onChange={(e) =>
                          updateLine(line.id, { quantity: Number.parseInt(e.target.value) || 1 })
                        }
                        className="w-14 text-center border border-sh-gray/30 rounded px-1 py-1 text-sm"
                      />
                    </td>
                    <td className="p-3 text-right">
                      <input
                        type="number"
                        step="0.01"
                        value={line.price}
                        onChange={(e) =>
                          updateLine(line.id, { price: Number.parseFloat(e.target.value) || 0 })
                        }
                        className="w-24 text-right border border-sh-gray/30 rounded px-1 py-1 text-sm"
                      />
                    </td>
                    <td className="p-3 text-right font-medium">
                      {fmt(line.price * line.quantity)}
                    </td>
                    <td className="p-3">
                      <button
                        onClick={() => removeLine(line.id)}
                        className="text-red-400 hover:text-red-600 text-xs"
                      >
                        X
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex justify-between items-center p-4 bg-sh-linen border-t border-sh-gray/20">
              <span className="text-sh-gray">{lines.length} item(s)</span>
              <span className="text-xl font-semibold text-sh-black">{fmt(total)}</span>
            </div>
          </>
        )}
      </div>

      {/* Notes */}
      <div className="bg-white border border-sh-gray/20 rounded-lg shadow-sm p-4 mb-4">
        <label className="block text-xs text-sh-gray mb-1">Order Notes</label>
        <textarea
          value={orderNotes}
          onChange={(e) => setOrderNotes(e.target.value)}
          rows={3}
          placeholder="Special instructions, fabric selections, delivery notes..."
          className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm focus:outline-none focus:border-sh-blue resize-none"
        />
      </div>

      {/* Actions */}
      {lines.length > 0 && (
        <div className="flex gap-3">
          <Button
            onClick={handleCreateQuote}
            disabled={submitting}
            className="flex-1 py-3 text-base"
          >
            {submitting ? "Creating..." : "Create Quote"}
          </Button>
        </div>
      )}
    </div>
  );
}
