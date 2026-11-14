"use client";

// /app/src/app/(dashboard)/app/sales/quotes/new/NewQuoteView.tsx
//
// New Quote builder. App Router port of the legacy sales/quotes/new body (minus
// MainLayout chrome, which the (dashboard) layout supplies). Reads + writes the
// shared REST endpoints (/api/store-locations, /api/customers/:id,
// /api/sales/orders/create-from-cart, /api/interactions/:id), which stay REST.
// Customer + product search hooks, configurator hand-off via sessionStorage,
// and line-item builder preserved verbatim.

import { useState, useEffect } from "react";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { toast } from "react-toastify";
import { useRouter, useSearchParams } from "next/navigation";
import { useActiveStore } from "@/hooks/useActiveStore";
import { NoTaxDistrictBanner } from "@/components/sales/NoTaxDistrictBanner";
import { useCustomerSearch, type CustomerSearchResult } from "@/hooks/useCustomerSearch";
import { useProductSearch } from "@/hooks/useProductSearch";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { RetailPriceTag } from "@/components/sales/RetailPriceTag";
import { useDiscountApproval } from "@/components/sales/useDiscountApproval";
import { useQuoteHoldPolicy } from "@/components/sales/useQuoteHoldPolicy";
import {
  catalogRetailPrice,
  catalogSale,
  lineSale,
  noRetailPriceMessage,
  type CatalogSale,
} from "@/lib/pos/cartPricing";
import {
  customerTradeTier,
  priceLineForTier,
  tierFieldsFromLookup,
  tradeLabel,
} from "@/lib/pricing/tradeTier";
import { getErrorMessage } from "@/lib/toastError";
import {
  SplitSaleField,
  emptySplit,
  splitBody,
  type SplitChoice,
} from "@/components/sales/SplitSaleField";
import type { SplitSaleSetup } from "@/lib/commissionSplit";

type ItemSource = "FLOOR" | "ORDER";
type FulfillmentMethod = "TAKE" | "PICKUP" | "DELIVERY";

/** SALE and the regular price struck through, while the line is at its sale price. */
function LineSaleNote({
  sale,
  fmt,
}: Readonly<{ sale: CatalogSale | null; fmt: (amount: number) => string }>) {
  if (!sale) return null;
  return (
    <p className="mt-1 text-[10px] text-brand-gray">
      <span className="rounded bg-red-100 px-1 py-0.5 font-semibold text-red-800">SALE</span>{" "}
      Regular <s>{fmt(sale.regularPrice)}</s>
    </p>
  );
}

interface QuoteLineItem {
  id: string;
  type: "PRODUCT" | "CONFIGURED" | "CUSTOM";
  productId: number | null;
  productNumber: string;
  name: string;
  description: string;
  /** The unit price it is quoted at: its retail, the customer's trade price, or a typed one. */
  price: number;
  /**
   * The unit price it was listed at -- its sale price while a scheduled sale is
   * on -- so a trade tier can come on and off (GAP-06 part C).
   */
  retail: number;
  /** Whether a customer's trade tier may discount it: catalog products the lookup allows. */
  tradeEligible: boolean;
  /** Whether `retail` is a sale price (the product lookup's onSale). */
  onSale?: boolean;
  /** Whether the store lets a tier come off a sale price (the product lookup says). */
  tradeDiscountOnSaleItems?: boolean;
  /** Someone typed the price: a customer's tier never moves it. */
  priceTyped: boolean;
  /** The trade tier's percent in `price`, or null: shown as "Trade 20%". */
  tradePercent: number | null;
  /** The scheduled sale this line was added at (catalogSale), for show only; see lineSale. */
  sale?: CatalogSale | null;
  cost: number;
  quantity: number;
  vendor: string;
  source: ItemSource;
  fulfillment: FulfillmentMethod;
  pickLocationId: number | null;
  /** Hold this floor-stock line for the customer through this day (GAP-16). */
  holdUntil: string | null;
}

interface StoreLocationOption {
  id: number;
  name: string;
  type: string;
}

/**
 * A line kept in sessionStorage across the configurator: one saved before the
 * trade-tier fields existed reads as priced by hand at the price it carried.
 */
function restoredLine(raw: QuoteLineItem): QuoteLineItem {
  return {
    ...raw,
    retail: typeof raw.retail === "number" ? raw.retail : raw.price,
    tradeEligible: raw.tradeEligible === true,
    priceTyped: raw.priceTyped === true,
    tradePercent: typeof raw.tradePercent === "number" ? raw.tradePercent : null,
  };
}

let lineCounter = 0;
function nextLineId(): string {
  lineCounter += 1;
  return `line-${lineCounter}`;
}

export function NewQuoteView({ splitSetup }: Readonly<{ splitSetup: SplitSaleSetup | null }>) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const fmt = useMoneyFormatter();
  const { activeStore, taxDistrictConfigured } = useActiveStore();
  const [lines, setLines] = useState<QuoteLineItem[]>([]);

  // Customer
  const {
    query: customerSearch,
    setQuery: setCustomerSearch,
    results: customerResults,
    clear: clearCustomerSearch,
  } = useCustomerSearch({ limit: 5 });
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerSearchResult | null>(null);
  // A trade customer's tier prices the quote's eligible lines (GAP-06 part C).
  const tradeTier = selectedCustomer?.tradeTier ?? null;
  // Picking, changing or removing the customer re-prices every line no one
  // typed a price on, so taking the customer off restores retail. The server
  // still judges each price it is sent (lib/sales/discountApproval.ts).
  const chooseCustomer = (customer: CustomerSearchResult | null) => {
    setSelectedCustomer(customer);
    setLines((prev) => prev.map((l) => priceLineForTier(l, customer?.tradeTier ?? null)));
  };

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
    fetch("/api/store-locations?isActive=true")
      .then((r) => r.json())
      .then((data) => {
        const locs = (data.locations ?? []).map((l: StoreLocationOption) => ({
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
  // A quote written with a colleague (GAP-07), for those allowed to split one.
  const [split, setSplit] = useState<SplitChoice>(() => emptySplit(splitSetup));
  const [submitting, setSubmitting] = useState(false);
  const { send: sendWithApproval, modal: approvalModal } = useDiscountApproval();
  const holdPolicy = useQuoteHoldPolicy();

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
      // The record carries its tier as stored; only an active one prices lines.
      .then((c) => chooseCustomer({ ...c, tradeTier: customerTradeTier(c.tradeTier) }))
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
        if (Array.isArray(state.lines) && state.lines.length > 0) {
          setLines((state.lines as QuoteLineItem[]).map(restoredLine));
        }
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
            // Priced by the configurator: a trade tier doesn't apply to it.
            retail: Number(item.price) || 0,
            tradeEligible: false,
            priceTyped: false,
            tradePercent: null,
            cost: Number(item.cost) || 0,
            quantity: 1,
            vendor: item.vendor || "",
            source: "ORDER" as ItemSource,
            fulfillment: "DELIVERY" as FulfillmentMethod,
            pickLocationId: null,
            holdUntil: null,
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
    regularRetail?: number | null;
    onSale?: boolean;
    saleEndsOn?: string | null;
    baseCost?: number | null;
    vendorName?: string;
    tradeEligible?: boolean;
    tradeDiscountOnSaleItems?: boolean;
  }) => {
    const price = catalogRetailPrice(p);
    if (price === null) {
      toast.error(noRetailPriceMessage(p));
      return;
    }

    setLines([
      ...lines,
      priceLineForTier(
        {
          id: nextLineId(),
          type: "PRODUCT",
          productId: p.id,
          productNumber: p.productNumber,
          name: p.name || p.productNumber,
          description: "",
          ...tierFieldsFromLookup(p, price),
          sale: catalogSale(p),
          cost: p.baseCost ? Number(p.baseCost) : 0,
          quantity: 1,
          vendor: p.vendorName || "",
          source: "FLOOR" as ItemSource,
          fulfillment: "TAKE" as FulfillmentMethod,
          pickLocationId: activeStore?.id ?? null,
          holdUntil: null,
        },
        tradeTier,
      ),
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
        // Priced by hand: a trade tier doesn't apply to it.
        retail: price,
        tradeEligible: false,
        priceTyped: true,
        tradePercent: null,
        cost: 0,
        quantity: qty,
        vendor: "",
        source: "ORDER" as ItemSource,
        fulfillment: "DELIVERY" as FulfillmentMethod,
        pickLocationId: null,
        holdUntil: null,
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
      // A price below list past what this person may give asks for a
      // manager's PIN and sends again (GAP-06); Cancel keeps the quote here.
      const res = await sendWithApproval((discountApproval) =>
        axios.post("/api/sales/orders/create-from-cart", {
          discountApproval,
          customerId: selectedCustomer?.id || null,
          storeLocation: activeStore?.name || null,
          orderNotes: orderNotes.trim() || null,
          ...splitBody(split),
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
            // A quote commits only the stock it holds (GAP-16).
            holdUntil:
              l.type === "PRODUCT" && l.source === "FLOOR" && l.holdUntil ? l.holdUntil : undefined,
          })),
        }),
      );
      if (!res) return;
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
      toast.error(getErrorMessage(err, "Failed to create quote"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto py-4 font-serif">
      {approvalModal}
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-semibold text-brand-blue">New Quote</h1>
        <Button variant="outline" onClick={() => router.push("/app/sales/orders")}>
          Cancel
        </Button>
      </div>

      <NoTaxDistrictBanner
        storeName={activeStore?.name}
        configured={taxDistrictConfigured}
        className="mb-4"
      />

      {/* Customer */}
      <div className="bg-white border border-brand-gray/20 rounded-lg shadow-sm p-4 mb-4">
        <p className="text-xs text-brand-gray mb-1">Customer</p>
        {selectedCustomer ? (
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm font-medium text-brand-black">
                {selectedCustomer.firstName} {selectedCustomer.lastName}
              </p>
              <p className="text-xs text-brand-gray">
                {[selectedCustomer.email, selectedCustomer.phone].filter(Boolean).join(" | ")}
              </p>
              {tradeTier && (
                <p className="text-xs text-brand-gold mt-0.5">
                  Trade tier: {tradeTier.name} ({tradeTier.discountPercent}% off retail)
                </p>
              )}
              {selectedCustomer.addresses?.length > 0 && (
                <p className="text-xs text-brand-gray mt-0.5">
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
              onClick={() => chooseCustomer(null)}
              className="text-xs text-brand-gray underline"
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
              className="w-full border border-brand-gray/30 rounded px-3 py-2 text-sm focus:outline-none focus:border-brand-blue"
            />
            {customerResults.length > 0 && (
              <div className="absolute z-10 top-full left-0 right-0 bg-white border border-brand-gray/20 rounded shadow-lg mt-1 max-h-40 overflow-y-auto">
                {customerResults.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => {
                      chooseCustomer(c);
                      clearCustomerSearch();
                    }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-brand-linen border-b border-brand-gray/10 last:border-0"
                  >
                    <span className="font-medium">
                      {c.firstName} {c.lastName}
                    </span>
                    {c.phone && <span className="text-brand-gray ml-2">{c.phone}</span>}
                    {c.tradeTier && (
                      <span className="text-brand-gold ml-2">{c.tradeTier.name}</span>
                    )}
                    {c.addresses?.length > 0 && (
                      <span className="block text-[10px] text-brand-gray">
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
      <div className="bg-white border border-brand-gray/20 rounded-lg shadow-sm p-4 mb-4 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-brand-black">Add Items</p>
          <div className="flex gap-2">
            <button
              onClick={() => setShowCustomForm(!showCustomForm)}
              className="px-3 py-1.5 text-xs rounded border border-brand-gray/30 text-brand-gray hover:border-brand-blue hover:text-brand-blue transition"
            >
              Custom Item
            </button>
            <button
              onClick={openConfigurator}
              className="px-3 py-1.5 text-xs rounded border border-brand-blue text-brand-blue hover:bg-brand-blue hover:text-white transition"
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
            className="w-full border border-brand-gray/30 rounded px-3 py-2 text-sm focus:outline-none focus:border-brand-blue"
          />
          {productResults.length > 0 && (
            <div className="absolute z-10 top-full left-0 right-0 bg-white border border-brand-gray/20 rounded shadow-lg mt-1 max-h-80 overflow-y-auto">
              {productResults.map((p) => (
                <button
                  key={p.id}
                  onClick={() => addProduct(p)}
                  className="w-full text-left px-3 py-2.5 text-sm hover:bg-brand-linen border-b border-brand-gray/10 last:border-0"
                >
                  <div className="flex justify-between items-start">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-brand-black truncate">{p.name}</p>
                      <p className="text-xs text-brand-gray">
                        {p.productNumber}
                        {p.vendorName && <span> -- {p.vendorName}</span>}
                      </p>
                    </div>
                    <RetailPriceTag price={catalogRetailPrice(p)} sale={catalogSale(p)} fmt={fmt} />
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Custom line item form */}
        {showCustomForm && (
          <div className="border border-brand-gray/20 rounded p-3 space-y-2 bg-brand-linen">
            <div className="grid grid-cols-2 gap-2">
              <input
                type="text"
                value={customForm.name}
                onChange={(e) => setCustomForm({ ...customForm, name: e.target.value })}
                placeholder="Item name"
                className="border border-brand-gray/30 rounded px-2 py-1.5 text-sm"
              />
              <input
                type="text"
                value={customForm.description}
                onChange={(e) => setCustomForm({ ...customForm, description: e.target.value })}
                placeholder="Description (optional)"
                className="border border-brand-gray/30 rounded px-2 py-1.5 text-sm"
              />
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                step="0.01"
                value={customForm.price}
                onChange={(e) => setCustomForm({ ...customForm, price: e.target.value })}
                placeholder="Price"
                className="w-28 border border-brand-gray/30 rounded px-2 py-1.5 text-sm"
              />
              <input
                type="number"
                min="1"
                value={customForm.quantity}
                onChange={(e) => setCustomForm({ ...customForm, quantity: e.target.value })}
                placeholder="Qty"
                className="w-16 border border-brand-gray/30 rounded px-2 py-1.5 text-sm"
              />
              <Button size="sm" onClick={addCustomLine}>
                Add
              </Button>
              <button
                onClick={() => setShowCustomForm(false)}
                className="text-xs text-brand-gray underline"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Line items */}
      <div className="bg-white border border-brand-gray/20 rounded-lg shadow-sm overflow-hidden mb-4">
        {lines.length === 0 ? (
          <p className="text-brand-gray text-center py-8">Add items to build a quote</p>
        ) : (
          <>
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-brand-linen border-b border-brand-gray/20">
                  <th className="text-left p-3 font-semibold">Item</th>
                  <th className="text-center p-3 font-semibold w-20">Qty</th>
                  <th className="text-right p-3 font-semibold w-28">Price</th>
                  <th className="text-right p-3 font-semibold w-28">Subtotal</th>
                  <th className="w-10"></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.id} className="border-b border-brand-gray/10">
                    <td className="p-3">
                      <p className="text-brand-black font-medium">{line.name}</p>
                      <p className="text-xs text-brand-gray">
                        {line.productNumber !== "CUSTOM" && line.productNumber}
                        {line.vendor && <span> -- {line.vendor}</span>}
                        {line.description && <span> -- {line.description}</span>}
                        {line.type === "CUSTOM" && (
                          <span className="ml-1 px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px]">
                            Custom
                          </span>
                        )}
                        {line.type === "CONFIGURED" && (
                          <span className="ml-1 px-1.5 py-0.5 rounded bg-brand-blue/10 text-brand-blue text-[10px]">
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
                              // A special order isn't floor stock: nothing to hold.
                              holdUntil: source === "ORDER" ? null : line.holdUntil,
                            });
                          }}
                          className="text-[10px] border border-brand-gray/30 rounded px-1 py-0.5 bg-white"
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
                            className="text-[10px] border border-brand-gray/30 rounded px-1 py-0.5 bg-white"
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
                          className="text-[10px] border border-brand-gray/30 rounded px-1 py-0.5 bg-white"
                        >
                          <option value="TAKE">Customer Take</option>
                          <option value="PICKUP">Pickup</option>
                          <option value="DELIVERY">Delivery</option>
                        </select>
                        {line.type === "PRODUCT" &&
                          line.source === "FLOOR" &&
                          holdPolicy?.latest && (
                            <label className="flex items-center gap-1 text-[10px] text-brand-gray">
                              Hold until
                              <input
                                type="date"
                                min={holdPolicy.today}
                                max={holdPolicy.latest}
                                value={line.holdUntil ?? ""}
                                onChange={(e) =>
                                  updateLine(line.id, { holdUntil: e.target.value || null })
                                }
                                aria-label={`Hold ${line.name} until`}
                                className="text-[10px] border border-brand-gray/30 rounded px-1 py-0.5 bg-white"
                              />
                            </label>
                          )}
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
                        className="w-14 text-center border border-brand-gray/30 rounded px-1 py-1 text-sm"
                      />
                    </td>
                    <td className="p-3 text-right">
                      <input
                        type="number"
                        step="0.01"
                        value={line.price}
                        onChange={(e) =>
                          // A typed price is the salesperson's: a trade tier no longer moves it.
                          updateLine(line.id, {
                            price: Number.parseFloat(e.target.value) || 0,
                            priceTyped: true,
                            tradePercent: null,
                          })
                        }
                        aria-label={`Price of ${line.name}`}
                        className="w-24 text-right border border-brand-gray/30 rounded px-1 py-1 text-sm"
                      />
                      <LineSaleNote
                        sale={lineSale(line.priceTyped ? line.price : line.retail, line.sale)}
                        fmt={fmt}
                      />
                      {line.tradePercent !== null && (
                        <p
                          className="text-[10px] text-brand-gold mt-0.5"
                          title={`Retail ${fmt(line.retail)} each`}
                        >
                          {tradeLabel(line.tradePercent)}
                        </p>
                      )}
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
            <div className="flex justify-between items-center p-4 bg-brand-linen border-t border-brand-gray/20">
              <span className="text-brand-gray">{lines.length} item(s)</span>
              <span className="text-xl font-semibold text-brand-black">{fmt(total)}</span>
            </div>
          </>
        )}
      </div>

      {/* Notes */}
      <div className="bg-white border border-brand-gray/20 rounded-lg shadow-sm p-4 mb-4">
        <label className="block text-xs text-brand-gray mb-1">Order Notes</label>
        <textarea
          value={orderNotes}
          onChange={(e) => setOrderNotes(e.target.value)}
          rows={3}
          placeholder="Special instructions, fabric selections, delivery notes..."
          className="w-full border border-brand-gray/30 rounded px-3 py-2 text-sm focus:outline-none focus:border-brand-blue resize-none"
        />
        {splitSetup && (
          <div className="mt-3">
            <SplitSaleField setup={splitSetup} value={split} onChange={setSplit} />
          </div>
        )}
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
