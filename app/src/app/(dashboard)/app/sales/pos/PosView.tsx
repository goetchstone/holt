"use client";

// /app/src/app/(dashboard)/app/sales/pos/PosView.tsx
//
// Point of Sale register body -- App Router port of the legacy pages/sales/pos.tsx
// (minus MainLayout chrome, which the (dashboard) layout supplies). Scan-to-cart,
// per-item + order discounts, return mode, order creation, and the tender +
// payment flow all read/write the shared /api/* REST endpoints exactly as before.
// Money is shown in cents (POS register precision) via useMoneyFormatter; the
// tender/change arithmetic is copied verbatim from the legacy page.

import { useState, useRef, useEffect, useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import axios from "axios";
import { useRouter } from "next/navigation";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import { useActiveStore } from "@/hooks/useActiveStore";
import { useCustomerSearch } from "@/hooks/useCustomerSearch";
import { useProductSearch } from "@/hooks/useProductSearch";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { getErrorMessage } from "@/lib/toastError";

const REGISTER_STORAGE_KEY = "pos-register-id";

interface Register {
  id: number;
  name: string;
  isActive: boolean;
  storeLocation: { id: number; name: string; code: string };
}

interface Discount {
  type: "PERCENT" | "FLAT";
  value: number;
  label: string;
}

interface InventorySummary {
  locationName: string;
  available: number;
}

interface CartItem {
  productId: number;
  productNumber: string;
  name: string;
  price: number;
  cost: number;
  quantity: number;
  discounts: Discount[];
  isReturn: boolean;
  inventorySummary: InventorySummary[];
}

interface CustomerResult {
  id: number;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
}

interface FoundProduct {
  id: number;
  productNumber: string;
  name?: string | null;
  baseRetail?: number | null;
  baseCost?: number | null;
}

interface GiftCardInfo {
  id: number;
  barcode: string;
  currentBalance: number;
}

interface CreatedOrder {
  id: number;
  orderno: string;
  total: number;
}

interface PaymentSummary {
  method: string;
  amount: number;
  change?: number;
  orderno: string;
}

type PaymentMethodType = "CASH" | "CHECK" | "CARD" | "GIFT_CARD";
type DeliveryMethod = "TAKEN" | "PICKUP" | "DELIVERY";

const PAYMENT_METHODS: PaymentMethodType[] = ["CASH", "CHECK", "CARD", "GIFT_CARD"];

const PAYMENT_METHOD_LABELS: Record<PaymentMethodType, string> = {
  CASH: "Cash",
  CHECK: "Check",
  CARD: "Card",
  GIFT_CARD: "Gift Card",
};

const DELIVERY_METHODS: DeliveryMethod[] = ["TAKEN", "PICKUP", "DELIVERY"];

const DELIVERY_METHOD_LABELS: Record<DeliveryMethod, string> = {
  TAKEN: "Taken",
  PICKUP: "Pickup",
  DELIVERY: "Delivery",
};

// Resolve a product's sell price: explicit retail, else 2.5x cost, else 0.
function resolvePrice(product: { baseRetail?: number | null; baseCost?: number | null }): number {
  if (product.baseRetail) return Number(product.baseRetail);
  if (product.baseCost) return Number(product.baseCost) * 2.5;
  return 0;
}

function calcItemTotal(item: CartItem): number {
  let price = item.price;
  for (const d of item.discounts) {
    if (d.type === "PERCENT") {
      price = price * (1 - d.value / 100);
    } else {
      price = price - d.value;
    }
  }
  if (price < 0) price = 0;
  const total = Math.round(price * item.quantity * 100) / 100;
  return item.isReturn ? -total : total;
}

function onHandAt(item: CartItem, locationName: string): number {
  const here = item.inventorySummary.find((s) => s.locationName === locationName);
  return here?.available ?? 0;
}

export function PosView() {
  const router = useRouter();
  const fmt = useMoneyFormatter();
  const scanRef = useRef<HTMLInputElement>(null);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [scanInput, setScanInput] = useState("");
  const [scanning, setScanning] = useState(false);
  const [returnMode, setReturnMode] = useState(false);
  const { activeStore, allStores, setActiveStore } = useActiveStore();

  // Register selection
  const [selectedRegister, setSelectedRegister] = useState<Register | null>(null);
  const [allRegisters, setAllRegisters] = useState<Register[]>([]);
  const [registersLoading, setRegistersLoading] = useState(true);
  const [showRegisterSelect, setShowRegisterSelect] = useState(false);

  // Product search (text-based, separate from barcode scan)
  const {
    query: productSearch,
    setQuery: setProductSearch,
    results: productResults,
    isSearching: searchingProducts,
    clear: clearProductSearch,
  } = useProductSearch({ limit: 20 });

  // Price editing
  const [editingPriceIdx, setEditingPriceIdx] = useState<number | null>(null);
  const [editPriceValue, setEditPriceValue] = useState("");

  // Created order -- when set, the payment section is shown instead of the cart
  const [createdOrder, setCreatedOrder] = useState<CreatedOrder | null>(null);

  // Payment flow state
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethodType | null>(null);
  const [tenderedAmount, setTenderedAmount] = useState("");
  const [checkNumber, setCheckNumber] = useState("");
  const [giftCardBarcode, setGiftCardBarcode] = useState("");
  const [giftCardInfo, setGiftCardInfo] = useState<GiftCardInfo | null>(null);
  const [giftCardError, setGiftCardError] = useState("");
  const [paymentProcessing, setPaymentProcessing] = useState(false);
  const [paymentComplete, setPaymentComplete] = useState(false);
  const [paymentSummary, setPaymentSummary] = useState<PaymentSummary | null>(null);

  // Order-level discount
  const [orderDiscount, setOrderDiscount] = useState<Discount | null>(null);
  const [showOrderDiscount, setShowOrderDiscount] = useState(false);
  const [orderDiscType, setOrderDiscType] = useState<"PERCENT" | "FLAT">("PERCENT");
  const [orderDiscValue, setOrderDiscValue] = useState("");

  // Per-item discount editing
  const [discountIdx, setDiscountIdx] = useState<number | null>(null);
  const [discType, setDiscType] = useState<"PERCENT" | "FLAT">("PERCENT");
  const [discValue, setDiscValue] = useState("");

  // Customer search
  const {
    query: customerSearch,
    setQuery: setCustomerSearch,
    results: customerResults,
    isSearching: searchingCustomer,
    clear: clearCustomerSearch,
  } = useCustomerSearch({ limit: 5 });
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerResult | null>(null);
  const [deliveryMethod, setDeliveryMethod] = useState<DeliveryMethod>("TAKEN");

  // Load all registers and restore saved selection from localStorage
  const loadRegisters = useCallback(async () => {
    setRegistersLoading(true);
    try {
      const res = await axios.get("/api/registers", { params: { limit: 200 } });
      const registers: Register[] = (res.data.registers || []).filter((r: Register) => r.isActive);
      setAllRegisters(registers);

      const savedId = localStorage.getItem(REGISTER_STORAGE_KEY);
      if (savedId) {
        const match = registers.find((r) => r.id === Number.parseInt(savedId));
        if (match) {
          setSelectedRegister(match);
        }
      }
    } catch {
      toast.error("Failed to load registers");
    } finally {
      setRegistersLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRegisters();
  }, [loadRegisters]);

  const handleSelectRegister = (register: Register) => {
    setSelectedRegister(register);
    localStorage.setItem(REGISTER_STORAGE_KEY, String(register.id));
    setShowRegisterSelect(false);
    // Sync the store selector to match the register's store
    if (register.storeLocation?.id) {
      const storeMatch = allStores.find((s) => s.name === register.storeLocation.name);
      if (storeMatch) {
        setActiveStore(storeMatch.id);
      }
    }
  };

  const handleChangeRegister = () => {
    setShowRegisterSelect(true);
  };

  useEffect(() => {
    if (selectedRegister && !showRegisterSelect && !createdOrder) {
      scanRef.current?.focus();
    }
  }, [selectedRegister, showRegisterSelect, createdOrder]);

  const subtotal = cart.reduce((sum, item) => sum + calcItemTotal(item), 0);
  const orderDiscountAmount = computeOrderDiscount(orderDiscount, subtotal);
  const cartTotal = Math.round((subtotal - orderDiscountAmount) * 100) / 100;
  const cartItemCount = cart.reduce((sum, item) => sum + Math.abs(item.quantity), 0);

  // Fetch on-hand counts per store location for informational display only.
  // Failures are silently ignored -- inventory never blocks a sale.
  const fetchInventorySummary = useCallback(
    async (productId: number): Promise<InventorySummary[]> => {
      try {
        const posRes = await axios.get("/api/warehouse/positions", {
          params: { productId, limit: 50 },
        });
        const positions = posRes.data.positions || [];
        // Aggregate quantity by store location name
        const byLocation: Record<string, number> = {};
        for (const p of positions) {
          if (p.quantity <= 0) continue;
          const locName = p.storeLocation?.name;
          if (!locName) continue;
          byLocation[locName] = (byLocation[locName] || 0) + p.quantity;
        }
        return Object.entries(byLocation).map(([locationName, available]) => ({
          locationName,
          available,
        }));
      } catch {
        return [];
      }
    },
    [],
  );

  const addProductToCart = useCallback(
    (product: FoundProduct, inventorySummary: InventorySummary[]) => {
      const price = resolvePrice(product);
      setCart((prev) => {
        const existingIdx = prev.findIndex(
          (item) => item.productId === product.id && item.isReturn === returnMode,
        );
        if (existingIdx >= 0) {
          const updated = [...prev];
          updated[existingIdx] = {
            ...updated[existingIdx],
            quantity: updated[existingIdx].quantity + 1,
          };
          return updated;
        }
        return [
          ...prev,
          {
            productId: product.id,
            productNumber: product.productNumber,
            name: product.name || product.productNumber,
            price,
            cost: product.baseCost ? Number(product.baseCost) : 0,
            quantity: 1,
            discounts: [],
            isReturn: returnMode,
            inventorySummary,
          },
        ];
      });
    },
    [returnMode],
  );

  const handleScan = useCallback(
    async (input: string) => {
      const trimmed = input.trim();
      if (!trimmed || scanning) return;

      // Gift card quick codes: GC = custom amount, GC25/GC50/etc = preset amount.
      // Gift card sales require scanning a physical card barcode, so redirect
      // to the dedicated gift card sale page which handles the full activation flow.
      const gcMatch = trimmed.toUpperCase().match(/^GC(\d*)$/);
      if (gcMatch) {
        setScanInput("");
        router.push(`/app/sales/gift-card-sale?code=${encodeURIComponent(trimmed.toUpperCase())}`);
        return;
      }

      setScanning(true);
      try {
        const res = await axios.get("/api/products/find-by-identifier", {
          params: { identifier: trimmed },
        });
        const product = res.data as FoundProduct;
        const inventorySummary = await fetchInventorySummary(product.id);
        addProductToCart(product, inventorySummary);
        toast.success(
          `${returnMode ? "Return" : "Added"}: ${product.name || product.productNumber}`,
        );
      } catch {
        toast.error(`Product not found: "${trimmed}"`);
      } finally {
        setScanInput("");
        setScanning(false);
        scanRef.current?.focus();
      }
    },
    [scanning, router, returnMode, fetchInventorySummary, addProductToCart],
  );

  const handleScanKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleScan(scanInput);
    }
  };

  const updateQuantity = (idx: number, qty: number) => {
    if (qty <= 0) {
      setCart(cart.filter((_, i) => i !== idx));
    } else {
      const updated = [...cart];
      updated[idx].quantity = qty;
      setCart(updated);
    }
  };

  const removeItem = (idx: number) => {
    setCart(cart.filter((_, i) => i !== idx));
    if (discountIdx === idx) setDiscountIdx(null);
  };

  const addItemDiscount = (idx: number) => {
    const val = Number.parseFloat(discValue);
    if (!val || val <= 0) return;
    const label = discType === "PERCENT" ? `${val}% off` : `${fmt(val)} off`;
    const updated = [...cart];
    updated[idx].discounts.push({ type: discType, value: val, label });
    setCart(updated);
    setDiscValue("");
    setDiscountIdx(null);
  };

  const clearItemDiscounts = (idx: number) => {
    const updated = [...cart];
    updated[idx].discounts = [];
    setCart(updated);
    setDiscountIdx(null);
  };

  const applyOrderDiscount = () => {
    const val = Number.parseFloat(orderDiscValue);
    if (!val || val <= 0) return;
    const label = orderDiscType === "PERCENT" ? `${val}% off order` : `${fmt(val)} off order`;
    setOrderDiscount({ type: orderDiscType, value: val, label });
    setShowOrderDiscount(false);
    setOrderDiscValue("");
  };

  const addProductFromSearch = async (product: FoundProduct) => {
    const inventorySummary = await fetchInventorySummary(product.id);
    addProductToCart(product, inventorySummary);
    clearProductSearch();
    scanRef.current?.focus();
    toast.success(`Added: ${product.name || product.productNumber}`);
  };

  const applyPriceEdit = (idx: number) => {
    const val = Number.parseFloat(editPriceValue);
    if (Number.isNaN(val) || val < 0) return;
    const updated = [...cart];
    updated[idx].price = val;
    setCart(updated);
    setEditingPriceIdx(null);
    setEditPriceValue("");
  };

  const handleCreateOrder = async () => {
    if (cart.length === 0) {
      toast.error("Cart is empty");
      return;
    }

    try {
      const res = await axios.post("/api/sales/orders/create-from-cart", {
        customerId: selectedCustomer?.id || null,
        storeLocation: activeStore?.name || null,
        registerId: selectedRegister?.id || null,
        items: cart.map((item) => ({
          productId: item.productId,
          quantity: item.isReturn ? -item.quantity : item.quantity,
          unitPrice: item.price,
          cost: item.cost || undefined,
          discounts: item.discounts,
          isReturn: item.isReturn,
        })),
        orderDiscount: orderDiscount || undefined,
        deliveryMethod,
      });
      toast.success(`Order ${res.data.orderno} created`);
      setCreatedOrder({ id: res.data.id, orderno: res.data.orderno, total: cartTotal });
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to create order"));
    }
  };

  // Look up a gift card by barcode to validate balance before payment
  const handleGiftCardLookup = async () => {
    const barcode = giftCardBarcode.trim();
    if (!barcode) return;
    setGiftCardError("");
    setGiftCardInfo(null);

    try {
      const res = await axios.get("/api/gift-cards/lookup", { params: { barcode } });
      const card = res.data;
      if (card.status === "VOIDED" || card.status === "EXPIRED") {
        setGiftCardError(`Gift card is ${card.status.toLowerCase()}`);
        return;
      }
      if (card.currentBalance <= 0) {
        setGiftCardError("Gift card has no remaining balance");
        return;
      }
      setGiftCardInfo({
        id: card.id,
        barcode: card.barcode,
        currentBalance: card.currentBalance,
      });
    } catch {
      setGiftCardError("Gift card not found");
    }
  };

  // Find the open till for the current register (needed for payment recording)
  const findOpenTill = async (): Promise<number | undefined> => {
    if (!selectedRegister) return undefined;
    try {
      const res = await axios.get("/api/tills", {
        params: { registerId: selectedRegister.id, status: "OPEN", limit: 1 },
      });
      const tills = res.data.tills || [];
      return tills.length > 0 ? tills[0].id : undefined;
    } catch {
      return undefined;
    }
  };

  // Validate the method-specific fields before recording. Returns an error
  // message to toast, or null when the tender is acceptable.
  const validatePayment = (method: PaymentMethodType, amount: number): string | null => {
    if (method === "CHECK" && !checkNumber.trim()) {
      return "Enter a check number";
    }
    if (method === "GIFT_CARD" && !giftCardInfo) {
      return "Look up a gift card first";
    }
    if (method === "GIFT_CARD" && giftCardInfo && giftCardInfo.currentBalance < amount) {
      return `Insufficient gift card balance: ${fmt(giftCardInfo.currentBalance)} available, ${fmt(amount)} required`;
    }
    if (method === "CASH") {
      const tendered = Number.parseFloat(tenderedAmount);
      if (Number.isNaN(tendered) || tendered < amount) {
        return "Tendered amount must be at least the order total";
      }
    }
    return null;
  };

  const handleRecordPayment = async () => {
    if (!createdOrder || !paymentMethod) return;
    const amount = createdOrder.total;
    if (amount <= 0) return;

    const validationError = validatePayment(paymentMethod, amount);
    if (validationError) {
      toast.error(validationError);
      return;
    }

    setPaymentProcessing(true);
    try {
      const tillId = await findOpenTill();

      const payload: Record<string, unknown> = {
        method: paymentMethod,
        amount,
        registerId: selectedRegister?.id,
        tillId,
        customerId: selectedCustomer?.id,
      };

      if (paymentMethod === "CHECK") {
        payload.checkNumber = checkNumber.trim();
      }
      if (paymentMethod === "GIFT_CARD" && giftCardInfo) {
        payload.giftCardId = giftCardInfo.id;
      }

      await axios.post(`/api/sales/orders/${createdOrder.id}/payments`, payload);

      const change =
        paymentMethod === "CASH"
          ? Math.round((Number.parseFloat(tenderedAmount) - amount) * 100) / 100
          : undefined;

      setPaymentComplete(true);
      setPaymentSummary({
        method: PAYMENT_METHOD_LABELS[paymentMethod],
        amount,
        change,
        orderno: createdOrder.orderno,
      });
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to record payment"));
    } finally {
      setPaymentProcessing(false);
    }
  };

  const resetPaymentFlow = () => {
    setPaymentMethod(null);
    setTenderedAmount("");
    setCheckNumber("");
    setGiftCardBarcode("");
    setGiftCardInfo(null);
    setGiftCardError("");
  };

  const handleNewTransaction = () => {
    setCart([]);
    setSelectedCustomer(null);
    setOrderDiscount(null);
    setReturnMode(false);
    setDeliveryMethod("TAKEN");
    setDiscountIdx(null);
    setCreatedOrder(null);
    resetPaymentFlow();
    setPaymentComplete(false);
    setPaymentSummary(null);
    scanRef.current?.focus();
  };

  const clearAll = () => {
    setCart([]);
    setSelectedCustomer(null);
    setOrderDiscount(null);
    setReturnMode(false);
    setDeliveryMethod("TAKEN");
    setDiscountIdx(null);
    scanRef.current?.focus();
  };

  // Show register selection screen if no register is chosen or user is changing
  const needsRegisterSelection = !registersLoading && (!selectedRegister || showRegisterSelect);

  // Render payment confirmation after successful payment
  if (paymentComplete && paymentSummary) {
    return (
      <PaymentCompletePanel
        summary={paymentSummary}
        fmt={fmt}
        onViewOrder={() => router.push(`/app/sales/orders/${createdOrder?.id}`)}
        onNewTransaction={handleNewTransaction}
      />
    );
  }

  // Render payment section after order is created
  if (createdOrder) {
    return (
      <TakePaymentPanel
        order={createdOrder}
        fmt={fmt}
        paymentMethod={paymentMethod}
        setPaymentMethod={setPaymentMethod}
        tenderedAmount={tenderedAmount}
        setTenderedAmount={setTenderedAmount}
        checkNumber={checkNumber}
        setCheckNumber={setCheckNumber}
        giftCardBarcode={giftCardBarcode}
        setGiftCardBarcode={setGiftCardBarcode}
        giftCardInfo={giftCardInfo}
        setGiftCardInfo={setGiftCardInfo}
        giftCardError={giftCardError}
        setGiftCardError={setGiftCardError}
        paymentProcessing={paymentProcessing}
        onLookupGiftCard={handleGiftCardLookup}
        onRecordPayment={handleRecordPayment}
        onResetFlow={resetPaymentFlow}
        onSkip={() => router.push(`/app/sales/orders/${createdOrder.id}`)}
      />
    );
  }

  if (registersLoading) {
    return (
      <div className="max-w-3xl mx-auto py-16 text-center font-serif">
        <p className="text-sh-gray">Loading registers...</p>
      </div>
    );
  }

  if (needsRegisterSelection) {
    return (
      <RegisterSelect
        registers={allRegisters}
        showCancel={showRegisterSelect && !!selectedRegister}
        onSelect={handleSelectRegister}
        onCancel={() => setShowRegisterSelect(false)}
      />
    );
  }

  return (
    <div className="max-w-3xl mx-auto py-4 font-serif">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-semibold text-sh-blue">Point of Sale</h1>
          {selectedRegister && (
            <p className="text-xs text-sh-gray mt-0.5">
              {selectedRegister.name} -- {selectedRegister.storeLocation?.name}
              <button
                onClick={handleChangeRegister}
                className="ml-2 text-sh-blue underline min-h-[44px] align-middle"
              >
                Change
              </button>
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <label htmlFor="pos-store" className="sr-only">
            Store
          </label>
          <select
            id="pos-store"
            value={activeStore?.id || ""}
            onChange={(e) => {
              if (e.target.value) setActiveStore(Number.parseInt(e.target.value));
            }}
            className="border border-sh-gray/30 rounded px-2 py-1.5 text-sm"
          >
            <option value="">Select Store</option>
            {allStores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button
            onClick={() => setReturnMode(!returnMode)}
            className={`px-3 py-1.5 text-sm rounded-full border transition ${
              returnMode
                ? "bg-red-100 text-red-800 border-red-300"
                : "bg-white text-sh-gray border-sh-gray/30 hover:border-sh-blue"
            }`}
          >
            {returnMode ? "Return Mode ON" : "Return Mode"}
          </button>
        </div>
      </div>

      {/* Customer */}
      <div className="bg-white border border-sh-gray/20 rounded-lg shadow-sm p-4 mb-4">
        {selectedCustomer ? (
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-sh-black">
                {selectedCustomer.firstName} {selectedCustomer.lastName}
              </p>
              <p className="text-xs text-sh-gray">
                {selectedCustomer.email || selectedCustomer.phone || "No contact info"}
              </p>
            </div>
            <button
              onClick={() => setSelectedCustomer(null)}
              className="text-xs text-sh-gray underline min-h-[44px] px-2"
            >
              Change
            </button>
          </div>
        ) : (
          <div className="relative">
            <label htmlFor="pos-customer" className="block text-xs text-sh-gray mb-1">
              Customer
            </label>
            <input
              id="pos-customer"
              type="text"
              value={customerSearch}
              onChange={(e) => setCustomerSearch(e.target.value)}
              placeholder="Search by name, phone, or email..."
              className="w-full border border-sh-gray/30 rounded px-3 py-2.5 text-sm focus:outline-none focus:border-sh-blue"
            />
            {customerResults.length > 0 && (
              <div className="absolute z-10 top-full left-0 right-0 bg-white border border-sh-gray/20 rounded shadow-lg mt-1 max-h-48 overflow-y-auto">
                {customerResults.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => {
                      setSelectedCustomer(c);
                      clearCustomerSearch();
                    }}
                    className="w-full text-left px-3 py-3 text-sm hover:bg-sh-linen border-b border-sh-gray/10 last:border-0 min-h-[44px]"
                  >
                    <span className="font-medium">
                      {c.firstName} {c.lastName}
                    </span>
                    {c.phone && <span className="text-sh-gray ml-2">{c.phone}</span>}
                    {c.email && <span className="text-sh-gray ml-2">{c.email}</span>}
                  </button>
                ))}
              </div>
            )}
            {searchingCustomer && <p className="text-xs text-sh-gray mt-1">Searching...</p>}
          </div>
        )}
      </div>

      {/* Scan input */}
      <div
        className={`border rounded-lg shadow-sm p-4 mb-4 ${
          returnMode ? "bg-red-50 border-red-200" : "bg-white border-sh-gray/20"
        }`}
      >
        <label htmlFor="pos-scan" className="block text-xs text-sh-gray mb-1">
          {returnMode ? "Scan item to return" : "Scan barcode or enter product number"}
        </label>
        <input
          id="pos-scan"
          ref={scanRef}
          type="text"
          value={scanInput}
          onChange={(e) => setScanInput(e.target.value)}
          onKeyDown={handleScanKeyDown}
          placeholder={returnMode ? "Scan return item..." : "Scan or type..."}
          className="w-full border border-sh-gray/30 rounded px-3 py-2.5 text-lg focus:outline-none focus:border-sh-blue"
          autoComplete="off"
        />
      </div>

      {/* Product search */}
      <div className="bg-white border border-sh-gray/20 rounded-lg shadow-sm p-4 mb-4 relative">
        <label htmlFor="pos-product-search" className="block text-xs text-sh-gray mb-1">
          Search products by name
        </label>
        <input
          id="pos-product-search"
          type="text"
          value={productSearch}
          onChange={(e) => setProductSearch(e.target.value)}
          placeholder="Type to search..."
          className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm focus:outline-none focus:border-sh-blue"
        />
        {productResults.length > 0 && (
          <div className="absolute z-10 top-full left-0 right-0 bg-white border border-sh-gray/20 rounded shadow-lg mt-1 max-h-80 overflow-y-auto mx-4">
            {productResults.map((p) => (
              <button
                key={p.id}
                onClick={() => addProductFromSearch(p)}
                className="w-full text-left px-3 py-2.5 text-sm hover:bg-sh-linen border-b border-sh-gray/10 last:border-0 min-h-[44px]"
              >
                <div className="flex justify-between items-start">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-sh-black truncate">{p.name}</p>
                    <p className="text-xs text-sh-gray">
                      {p.productNumber}
                      {p.vendorName && <span> -- {p.vendorName}</span>}
                      {p.categoryName && <span> -- {p.categoryName}</span>}
                    </p>
                  </div>
                  {p.baseRetail && (
                    <span className="text-sm text-sh-black ml-3 whitespace-nowrap">
                      {fmt(Number(p.baseRetail))}
                    </span>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
        {searchingProducts && <p className="text-xs text-sh-gray mt-1">Searching...</p>}
      </div>

      {/* Cart */}
      <div className="bg-white border border-sh-gray/20 rounded-lg shadow-sm overflow-hidden mb-4">
        {cart.length === 0 ? (
          <p className="text-sh-gray text-center py-8">Scan an item to start</p>
        ) : (
          <>
            {cart.map((item, idx) => (
              <CartRow
                key={`${item.productId}-${item.isReturn}`}
                item={item}
                idx={idx}
                fmt={fmt}
                registerStoreName={selectedRegister?.storeLocation.name}
                isEditingPrice={editingPriceIdx === idx}
                editPriceValue={editPriceValue}
                setEditPriceValue={setEditPriceValue}
                onBeginPriceEdit={() => {
                  setEditingPriceIdx(idx);
                  setEditPriceValue(item.price.toFixed(2));
                }}
                onApplyPriceEdit={() => applyPriceEdit(idx)}
                onCancelPriceEdit={() => {
                  setEditingPriceIdx(null);
                  setEditPriceValue("");
                }}
                onDecrementQuantity={() => updateQuantity(idx, item.quantity - 1)}
                onIncrementQuantity={() => updateQuantity(idx, item.quantity + 1)}
                onRemove={() => removeItem(idx)}
                onClearItemDiscounts={() => clearItemDiscounts(idx)}
                isDiscountOpen={discountIdx === idx}
                onToggleDiscount={() => setDiscountIdx(discountIdx === idx ? null : idx)}
                discType={discType}
                setDiscType={setDiscType}
                discValue={discValue}
                setDiscValue={setDiscValue}
                onAddItemDiscount={() => addItemDiscount(idx)}
                onCancelItemDiscount={() => setDiscountIdx(null)}
              />
            ))}

            {/* Totals */}
            <div className="p-4 bg-sh-linen border-t border-sh-gray/20 space-y-1">
              <div className="flex justify-between text-sm text-sh-gray">
                <span>{cartItemCount} item(s)</span>
                <span>Subtotal: {fmt(subtotal)}</span>
              </div>
              {orderDiscount && (
                <div className="flex justify-between text-sm text-green-700">
                  <span className="flex items-center gap-2">
                    {orderDiscount.label}
                    <button
                      onClick={() => setOrderDiscount(null)}
                      className="text-[10px] text-red-500 underline"
                    >
                      remove
                    </button>
                  </span>
                  <span>-{fmt(orderDiscountAmount)}</span>
                </div>
              )}
              <div className="flex justify-between items-center pt-1">
                <button
                  onClick={() => setShowOrderDiscount(!showOrderDiscount)}
                  className="text-xs text-sh-blue hover:underline"
                >
                  {orderDiscount ? "Change Order Discount" : "Add Order Discount"}
                </button>
                <span className="text-xl font-semibold text-sh-black">{fmt(cartTotal)}</span>
              </div>

              {showOrderDiscount && (
                <div className="flex items-center gap-2 pt-2">
                  <label htmlFor="pos-order-disc-type" className="sr-only">
                    Order discount type
                  </label>
                  <select
                    id="pos-order-disc-type"
                    value={orderDiscType}
                    onChange={(e) => setOrderDiscType(e.target.value as "PERCENT" | "FLAT")}
                    className="border border-sh-gray/30 rounded px-1.5 py-1 text-xs"
                  >
                    <option value="PERCENT">%</option>
                    <option value="FLAT">$</option>
                  </select>
                  <label htmlFor="pos-order-disc-value" className="sr-only">
                    Order discount amount
                  </label>
                  <input
                    id="pos-order-disc-value"
                    type="number"
                    step="0.01"
                    value={orderDiscValue}
                    onChange={(e) => setOrderDiscValue(e.target.value)}
                    placeholder="Amount"
                    className="w-24 border border-sh-gray/30 rounded px-2 py-1 text-xs"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Enter") applyOrderDiscount();
                    }}
                  />
                  <button
                    onClick={applyOrderDiscount}
                    className="text-xs text-sh-blue hover:underline"
                  >
                    Apply
                  </button>
                  <button
                    onClick={() => setShowOrderDiscount(false)}
                    className="text-xs text-sh-gray hover:underline"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Conveyance + Actions */}
      {cart.length > 0 && (
        <div className="space-y-3">
          <div className="bg-white border border-sh-gray/20 rounded-lg shadow-sm p-4">
            <p className="block text-xs text-sh-gray mb-2">Conveyance</p>
            <div className="flex gap-2">
              {DELIVERY_METHODS.map((method) => (
                <button
                  key={method}
                  onClick={() => setDeliveryMethod(method)}
                  className={`flex-1 px-3 py-2.5 text-sm rounded border transition min-h-[44px] ${
                    deliveryMethod === method
                      ? "bg-sh-blue text-white border-sh-blue"
                      : "bg-white text-sh-gray border-sh-gray/30 hover:border-sh-blue"
                  }`}
                >
                  {DELIVERY_METHOD_LABELS[method]}
                </button>
              ))}
            </div>
          </div>
          <div className="flex gap-3">
            <Button onClick={handleCreateOrder} className="flex-1 py-3 text-base">
              Create Order
            </Button>
            <Button variant="outline" onClick={clearAll}>
              Clear All
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// Order-level discount amount: percent of subtotal (rounded to cents) or a flat
// amount capped at the subtotal. Copied verbatim from the legacy register math.
function computeOrderDiscount(orderDiscount: Discount | null, subtotal: number): number {
  if (!orderDiscount) return 0;
  if (orderDiscount.type === "PERCENT") {
    return Math.round(subtotal * (orderDiscount.value / 100) * 100) / 100;
  }
  return Math.min(orderDiscount.value, subtotal);
}

type MoneyFmt = ReturnType<typeof useMoneyFormatter>;

function RegisterSelect({
  registers,
  showCancel,
  onSelect,
  onCancel,
}: Readonly<{
  registers: Register[];
  showCancel: boolean;
  onSelect: (register: Register) => void;
  onCancel: () => void;
}>) {
  // Group registers by store location for the selection screen
  const registersByStore = registers.reduce<Record<string, Register[]>>((acc, r) => {
    const storeName = r.storeLocation?.name || "Unknown";
    if (!acc[storeName]) acc[storeName] = [];
    acc[storeName].push(r);
    return acc;
  }, {});

  return (
    <div className="max-w-2xl mx-auto py-8 font-serif">
      <h1 className="text-2xl font-semibold text-sh-blue text-center mb-8">Select Your Register</h1>

      {registers.length === 0 ? (
        <p className="text-sh-gray text-center">
          No active registers found. Set up registers in Admin before using POS.
        </p>
      ) : (
        <div className="space-y-6">
          {Object.entries(registersByStore).map(([storeName, storeRegisters]) => (
            <div key={storeName}>
              <h2 className="text-sm font-medium text-sh-gray uppercase tracking-wide mb-3">
                {storeName}
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {storeRegisters.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => onSelect(r)}
                    className="h-[60px] px-4 text-left bg-white border border-sh-gray/20 rounded-lg shadow-sm hover:border-sh-blue hover:shadow-md transition text-sh-black font-medium text-base"
                  >
                    {r.name}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {showCancel && (
        <div className="mt-8 text-center">
          <button onClick={onCancel} className="text-sm text-sh-gray underline min-h-[44px] px-4">
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

function PaymentCompletePanel({
  summary,
  fmt,
  onViewOrder,
  onNewTransaction,
}: Readonly<{
  summary: PaymentSummary;
  fmt: MoneyFmt;
  onViewOrder: () => void;
  onNewTransaction: () => void;
}>) {
  return (
    <div className="max-w-lg mx-auto py-12 font-serif text-center">
      <div className="bg-white border border-sh-gray/20 rounded-lg shadow-sm p-8">
        <h2 className="text-2xl font-semibold text-sh-blue mb-6">Payment Complete</h2>
        <div className="space-y-3 text-sm text-sh-black mb-8">
          <p>
            <span className="text-sh-gray">Order:</span> {summary.orderno}
          </p>
          <p>
            <span className="text-sh-gray">Method:</span> {summary.method}
          </p>
          <p>
            <span className="text-sh-gray">Amount:</span> {fmt(summary.amount)}
          </p>
          {summary.change !== undefined && summary.change > 0 && (
            <p className="text-lg font-semibold text-sh-blue mt-4">
              Change Due: {fmt(summary.change)}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-3">
          <Button onClick={onViewOrder} variant="outline" className="h-[60px] text-base">
            View Order
          </Button>
          <Button onClick={onNewTransaction} className="h-[60px] text-base">
            New Transaction
          </Button>
        </div>
      </div>
    </div>
  );
}

function TakePaymentPanel({
  order,
  fmt,
  paymentMethod,
  setPaymentMethod,
  tenderedAmount,
  setTenderedAmount,
  checkNumber,
  setCheckNumber,
  giftCardBarcode,
  setGiftCardBarcode,
  giftCardInfo,
  setGiftCardInfo,
  giftCardError,
  setGiftCardError,
  paymentProcessing,
  onLookupGiftCard,
  onRecordPayment,
  onResetFlow,
  onSkip,
}: Readonly<{
  order: CreatedOrder;
  fmt: MoneyFmt;
  paymentMethod: PaymentMethodType | null;
  setPaymentMethod: Dispatch<SetStateAction<PaymentMethodType | null>>;
  tenderedAmount: string;
  setTenderedAmount: Dispatch<SetStateAction<string>>;
  checkNumber: string;
  setCheckNumber: Dispatch<SetStateAction<string>>;
  giftCardBarcode: string;
  setGiftCardBarcode: Dispatch<SetStateAction<string>>;
  giftCardInfo: GiftCardInfo | null;
  setGiftCardInfo: Dispatch<SetStateAction<GiftCardInfo | null>>;
  giftCardError: string;
  setGiftCardError: Dispatch<SetStateAction<string>>;
  paymentProcessing: boolean;
  onLookupGiftCard: () => void;
  onRecordPayment: () => void;
  onResetFlow: () => void;
  onSkip: () => void;
}>) {
  const cashChange =
    tenderedAmount && Number.parseFloat(tenderedAmount) >= order.total
      ? Math.round((Number.parseFloat(tenderedAmount) - order.total) * 100) / 100
      : null;

  return (
    <div className="max-w-lg mx-auto py-8 font-serif">
      <div className="bg-white border border-sh-gray/20 rounded-lg shadow-sm p-6 mb-6">
        <div className="flex justify-between items-start mb-2">
          <div>
            <h2 className="text-xl font-semibold text-sh-blue">Take Payment</h2>
            <p className="text-sm text-sh-gray mt-1">Order {order.orderno}</p>
          </div>
          <span className="text-2xl font-semibold text-sh-black">{fmt(order.total)}</span>
        </div>
      </div>

      {!paymentMethod ? (
        <div className="grid grid-cols-2 gap-4">
          {PAYMENT_METHODS.map((method) => (
            <button
              key={method}
              onClick={() => setPaymentMethod(method)}
              className="h-[60px] bg-white border border-sh-gray/20 rounded-lg shadow-sm text-sh-black font-semibold text-lg hover:border-sh-blue hover:shadow-md transition"
            >
              {PAYMENT_METHOD_LABELS[method]}
            </button>
          ))}
        </div>
      ) : (
        <div className="bg-white border border-sh-gray/20 rounded-lg shadow-sm p-6 space-y-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-lg font-semibold text-sh-black">
              {PAYMENT_METHOD_LABELS[paymentMethod]} Payment
            </h3>
            <button
              onClick={onResetFlow}
              className="text-sm text-sh-gray underline min-h-[44px] px-2"
            >
              Back
            </button>
          </div>

          {paymentMethod === "CASH" && (
            <div className="space-y-4">
              <div>
                <label htmlFor="pos-tendered" className="block text-xs text-sh-gray mb-1">
                  Amount Tendered
                </label>
                <input
                  id="pos-tendered"
                  type="number"
                  step="0.01"
                  min={order.total}
                  value={tenderedAmount}
                  onChange={(e) => setTenderedAmount(e.target.value)}
                  placeholder={order.total.toFixed(2)}
                  className="w-full border border-sh-gray/30 rounded px-3 py-3 text-lg focus:outline-none focus:border-sh-blue"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onRecordPayment();
                  }}
                />
              </div>
              {cashChange !== null && (
                <div className="bg-sh-linen rounded-lg p-3 text-center">
                  <p className="text-sm text-sh-gray">Change Due</p>
                  <p className="text-2xl font-semibold text-sh-blue">{fmt(cashChange)}</p>
                </div>
              )}
            </div>
          )}

          {paymentMethod === "CHECK" && (
            <div>
              <label htmlFor="pos-check-number" className="block text-xs text-sh-gray mb-1">
                Check Number
              </label>
              <input
                id="pos-check-number"
                type="text"
                value={checkNumber}
                onChange={(e) => setCheckNumber(e.target.value)}
                placeholder="Enter check number"
                className="w-full border border-sh-gray/30 rounded px-3 py-3 text-lg focus:outline-none focus:border-sh-blue"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") onRecordPayment();
                }}
              />
            </div>
          )}

          {paymentMethod === "CARD" && (
            <p className="text-sm text-sh-gray py-2">
              Card payment will be recorded. Stripe reader integration coming soon.
            </p>
          )}

          {paymentMethod === "GIFT_CARD" && (
            <div className="space-y-3">
              <div>
                <label htmlFor="pos-giftcard" className="block text-xs text-sh-gray mb-1">
                  Gift Card Barcode / Number
                </label>
                <div className="flex gap-2">
                  <input
                    id="pos-giftcard"
                    type="text"
                    value={giftCardBarcode}
                    onChange={(e) => {
                      setGiftCardBarcode(e.target.value);
                      setGiftCardError("");
                      setGiftCardInfo(null);
                    }}
                    placeholder="Scan or enter gift card number"
                    className="flex-1 border border-sh-gray/30 rounded px-3 py-3 text-lg focus:outline-none focus:border-sh-blue"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Enter") onLookupGiftCard();
                    }}
                  />
                  <button
                    onClick={onLookupGiftCard}
                    disabled={!giftCardBarcode.trim()}
                    className="px-4 py-3 bg-sh-blue text-white rounded font-semibold text-sm hover:bg-sh-black transition disabled:opacity-50 disabled:cursor-not-allowed min-h-[44px]"
                  >
                    Look Up
                  </button>
                </div>
              </div>
              {giftCardError && <p className="text-sm text-red-600">{giftCardError}</p>}
              {giftCardInfo && (
                <div className="bg-sh-linen rounded-lg p-3">
                  <p className="text-xs text-sh-gray">Card: {giftCardInfo.barcode}</p>
                  <p className="text-sm font-medium text-sh-black">
                    Balance: {fmt(giftCardInfo.currentBalance)}
                  </p>
                  {giftCardInfo.currentBalance < order.total && (
                    <p className="text-xs text-red-600 mt-1">
                      Insufficient balance for {fmt(order.total)} order total
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          <Button
            onClick={onRecordPayment}
            disabled={paymentProcessing}
            fullWidth
            className="h-[60px] text-lg"
          >
            {paymentProcessing
              ? "Processing..."
              : `Record ${PAYMENT_METHOD_LABELS[paymentMethod]} Payment -- ${fmt(order.total)}`}
          </Button>
        </div>
      )}

      <div className="mt-6 text-center">
        <button onClick={onSkip} className="text-sm text-sh-gray underline min-h-[44px] px-4">
          Skip payment and view order
        </button>
      </div>
    </div>
  );
}

type CartRowProps = Readonly<{
  item: CartItem;
  idx: number;
  fmt: MoneyFmt;
  registerStoreName?: string;
  isEditingPrice: boolean;
  editPriceValue: string;
  setEditPriceValue: Dispatch<SetStateAction<string>>;
  onBeginPriceEdit: () => void;
  onApplyPriceEdit: () => void;
  onCancelPriceEdit: () => void;
  onDecrementQuantity: () => void;
  onIncrementQuantity: () => void;
  onRemove: () => void;
  onClearItemDiscounts: () => void;
  isDiscountOpen: boolean;
  onToggleDiscount: () => void;
  discType: "PERCENT" | "FLAT";
  setDiscType: Dispatch<SetStateAction<"PERCENT" | "FLAT">>;
  discValue: string;
  setDiscValue: Dispatch<SetStateAction<string>>;
  onAddItemDiscount: () => void;
  onCancelItemDiscount: () => void;
}>;

function CartRow({
  item,
  idx,
  fmt,
  registerStoreName,
  isEditingPrice,
  editPriceValue,
  setEditPriceValue,
  onBeginPriceEdit,
  onApplyPriceEdit,
  onCancelPriceEdit,
  onDecrementQuantity,
  onIncrementQuantity,
  onRemove,
  onClearItemDiscounts,
  isDiscountOpen,
  onToggleDiscount,
  discType,
  setDiscType,
  discValue,
  setDiscValue,
  onAddItemDiscount,
  onCancelItemDiscount,
}: CartRowProps) {
  const onHandHere = registerStoreName ? onHandAt(item, registerStoreName) : 0;

  return (
    <div className={`border-b border-sh-gray/10 p-3 ${item.isReturn ? "bg-red-50" : ""}`}>
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-sh-black truncate">{item.name}</p>
            {item.isReturn && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-200 text-red-800">
                RETURN
              </span>
            )}
          </div>
          <p className="text-xs text-sh-gray">{item.productNumber}</p>
          {registerStoreName && (
            <p className="text-xs mt-1">
              <span className="text-sh-gray">Source: </span>
              <span className="font-medium text-sh-blue">{registerStoreName}</span>
              {onHandHere > 0 ? (
                <span className="text-sh-gray"> ({onHandHere} on hand)</span>
              ) : (
                <span className="text-red-700 font-medium"> -- 0 on hand here</span>
              )}
            </p>
          )}
          {item.inventorySummary.length > 0 && (
            <p className="text-xs text-sh-gray mt-0.5">
              <span className="uppercase tracking-wide text-[10px]">Stock:</span>{" "}
              {item.inventorySummary.map((s) => `${s.locationName} ${s.available}`).join(" · ")}
            </p>
          )}
          {item.discounts.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {item.discounts.map((d, di) => (
                <span
                  key={di}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 text-green-800"
                >
                  {d.label}
                </span>
              ))}
              <button onClick={onClearItemDiscounts} className="text-[10px] text-red-500 underline">
                clear
              </button>
            </div>
          )}
        </div>

        {/* Qty controls */}
        <div className="flex items-center gap-1">
          <button
            onClick={onDecrementQuantity}
            className="w-7 h-7 rounded border border-sh-gray/30 text-sh-gray hover:bg-sh-linen text-sm"
          >
            -
          </button>
          <span className="w-8 text-center text-sm">{item.quantity}</span>
          <button
            onClick={onIncrementQuantity}
            className="w-7 h-7 rounded border border-sh-gray/30 text-sh-gray hover:bg-sh-linen text-sm"
          >
            +
          </button>
        </div>

        {/* Price and actions */}
        <div className="text-right min-w-[80px]">
          {isEditingPrice ? (
            <div className="flex items-center gap-1">
              <label htmlFor={`pos-price-${idx}`} className="sr-only">
                Edit price
              </label>
              <input
                id={`pos-price-${idx}`}
                type="number"
                step="0.01"
                value={editPriceValue}
                onChange={(e) => setEditPriceValue(e.target.value)}
                onBlur={onApplyPriceEdit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onApplyPriceEdit();
                  if (e.key === "Escape") onCancelPriceEdit();
                }}
                className="w-20 text-xs border border-sh-gray/30 rounded px-1.5 py-1 text-right"
                autoFocus
              />
            </div>
          ) : (
            <button
              onClick={onBeginPriceEdit}
              className="text-sm font-medium hover:text-sh-blue"
              title="Click to edit price"
            >
              {fmt(calcItemTotal(item))}
            </button>
          )}
          {item.discounts.length > 0 && !isEditingPrice && (
            <p className="text-[10px] text-sh-gray line-through">
              {fmt(item.price * item.quantity)}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <button onClick={onToggleDiscount} className="text-[10px] text-sh-blue hover:underline">
            Disc
          </button>
          <button onClick={onRemove} className="text-[10px] text-red-400 hover:text-red-600">
            X
          </button>
        </div>
      </div>

      {/* Inline discount form */}
      {isDiscountOpen && (
        <div className="flex items-center gap-2 mt-2 pl-1">
          <label htmlFor={`pos-item-disc-type-${idx}`} className="sr-only">
            Discount type
          </label>
          <select
            id={`pos-item-disc-type-${idx}`}
            value={discType}
            onChange={(e) => setDiscType(e.target.value as "PERCENT" | "FLAT")}
            className="border border-sh-gray/30 rounded px-1.5 py-1 text-xs"
          >
            <option value="PERCENT">%</option>
            <option value="FLAT">$</option>
          </select>
          <label htmlFor={`pos-item-disc-value-${idx}`} className="sr-only">
            Discount amount
          </label>
          <input
            id={`pos-item-disc-value-${idx}`}
            type="number"
            step="0.01"
            value={discValue}
            onChange={(e) => setDiscValue(e.target.value)}
            placeholder="Amount"
            className="w-20 border border-sh-gray/30 rounded px-2 py-1 text-xs"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") onAddItemDiscount();
            }}
          />
          <button onClick={onAddItemDiscount} className="text-xs text-sh-blue hover:underline">
            Apply
          </button>
          <button onClick={onCancelItemDiscount} className="text-xs text-sh-gray hover:underline">
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
