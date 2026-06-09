"use client";

// /app/src/app/(dashboard)/app/sales/returns/new/NewReturnView.tsx
//
// Initiate Return wizard. App Router port of the legacy sales/returns/new body
// (minus MainLayout chrome, which the (dashboard) layout supplies). Reads + writes
// the shared REST endpoints (/api/sales/orders[/:id], /api/returns), which stay
// REST. Order search, line-item selection, and pickup details preserved.

import { useState, useEffect, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import axios from "axios";
import { toast } from "react-toastify";
import { format } from "date-fns";
import { parseLocalDate } from "@/lib/dateUtils";
import { ArrowLeft, Search } from "lucide-react";
import Link from "next/link";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";

interface OrderSearchResult {
  id: number;
  orderno: string;
  orderDate: string;
  status: string;
  customer: {
    id: number;
    firstName: string;
    lastName: string;
  } | null;
}

interface OrderLineItem {
  id: number;
  productName: string;
  partNo: string | null;
  orderedQuantity: number;
  netPrice: number;
  productId: number | null;
}

interface CustomerAddress {
  id: number;
  address1: string;
  address2: string | null;
  city: string;
  state: string;
  zip: string;
}

interface OrderDetail {
  id: number;
  orderno: string;
  orderDate: string;
  customer: {
    id: number;
    firstName: string;
    lastName: string;
    addresses: CustomerAddress[];
  } | null;
  lineItems: OrderLineItem[];
}

const REASON_OPTIONS = [
  { value: "DEFECTIVE", label: "Defective" },
  { value: "DAMAGED_IN_DELIVERY", label: "Damaged in Delivery" },
  { value: "WRONG_ITEM", label: "Wrong Item" },
  { value: "CUSTOMER_CHANGED_MIND", label: "Customer Changed Mind" },
  { value: "NOT_AS_DESCRIBED", label: "Not as Described" },
  { value: "DUPLICATE_ORDER", label: "Duplicate Order" },
  { value: "OTHER", label: "Other" },
];

const TIME_SLOTS = [
  { value: "AM", label: "AM (8:00 - 12:00)" },
  { value: "PM", label: "PM (12:00 - 5:00)" },
];

export function NewReturnView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const formatCurrency = useMoneyFormatter();
  const queryOrderId = searchParams?.get("orderId");

  // Step tracking
  const [step, setStep] = useState<1 | 2 | 3>(1);

  // Step 1: Order search
  const [orderSearchInput, setOrderSearchInput] = useState("");
  const [orderSearchResults, setOrderSearchResults] = useState<OrderSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

  // Step 2: Order + line item selection
  const [selectedOrder, setSelectedOrder] = useState<OrderDetail | null>(null);
  const [selectedLineItemId, setSelectedLineItemId] = useState<number | null>(null);
  const [orderLoading, setOrderLoading] = useState(false);

  // Step 3: Return details
  const [reason, setReason] = useState("");
  const [reasonNotes, setReasonNotes] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [pickupRequired, setPickupRequired] = useState(false);
  const [pickupAddressId, setPickupAddressId] = useState<number | "">("");
  const [pickupDate, setPickupDate] = useState("");
  const [pickupTimeSlot, setPickupTimeSlot] = useState("");

  const [submitting, setSubmitting] = useState(false);

  const loadOrder = useCallback(async (orderId: number) => {
    setOrderLoading(true);
    try {
      const res = await axios.get(`/api/sales/orders/${orderId}`);
      setSelectedOrder(res.data);
      setSelectedLineItemId(null);
      setStep(2);
    } catch {
      toast.error("Failed to load order details.");
    } finally {
      setOrderLoading(false);
    }
  }, []);

  // Auto-load order from query param
  useEffect(() => {
    if (queryOrderId) {
      loadOrder(Number.parseInt(queryOrderId, 10));
    }
  }, [queryOrderId, loadOrder]);

  const searchOrders = async () => {
    if (!orderSearchInput.trim()) return;
    setSearchLoading(true);
    try {
      const res = await axios.get("/api/sales/orders", {
        params: { search: orderSearchInput, limit: 5 },
      });
      setOrderSearchResults(res.data.orders || []);
      if ((res.data.orders || []).length === 0) {
        toast.info("No orders found.");
      }
    } catch {
      toast.error("Failed to search orders.");
    } finally {
      setSearchLoading(false);
    }
  };

  const handleSelectOrder = (order: OrderSearchResult) => {
    loadOrder(order.id);
  };

  const handleLineItemSelected = () => {
    if (!selectedLineItemId) {
      toast.error("Please select a line item.");
      return;
    }
    setStep(3);
  };

  const handleSubmit = async () => {
    if (!selectedOrder || !selectedLineItemId || !reason) {
      toast.error("Please complete all required fields.");
      return;
    }
    if (pickupRequired && !pickupAddressId) {
      toast.error("Please select a pickup address.");
      return;
    }

    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        orderId: selectedOrder.id,
        lineItemId: selectedLineItemId,
        reason,
        reasonNotes: reasonNotes || undefined,
        quantity,
        pickupRequired,
      };

      if (pickupRequired) {
        payload.pickupAddressId = pickupAddressId;
        payload.pickupDate = pickupDate || undefined;
        payload.pickupTimeSlot = pickupTimeSlot || undefined;
      }

      const res = await axios.post("/api/returns", payload);
      toast.success("Return initiated.");
      router.push(`/app/sales/returns/${res.data.id}`);
    } catch (err: unknown) {
      const message =
        axios.isAxiosError(err) && err.response?.data?.error
          ? err.response.data.error
          : "Failed to create return";
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  const selectedLineItem = selectedOrder?.lineItems.find((li) => li.id === selectedLineItemId);

  return (
    <div className="max-w-3xl mx-auto mt-8 font-serif">
      <Link
        href="/app/sales/returns"
        className="inline-flex items-center text-sm text-sh-gray hover:text-sh-blue transition mb-4"
      >
        <ArrowLeft className="w-4 h-4 mr-1" />
        Back to Returns
      </Link>

      <h1 className="text-2xl font-bold text-sh-blue mb-6">Initiate Return</h1>

      {/* Step indicators */}
      <div className="flex items-center gap-2 mb-6">
        {[1, 2, 3].map((s) => (
          <div key={s} className="flex items-center gap-2">
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold ${
                step === s
                  ? "bg-sh-blue text-white"
                  : step > s
                    ? "bg-sh-gold text-white"
                    : "bg-sh-gray/20 text-sh-gray"
              }`}
            >
              {s}
            </div>
            <span className={`text-sm ${step === s ? "text-sh-blue font-medium" : "text-sh-gray"}`}>
              {s === 1 ? "Find Order" : s === 2 ? "Select Item" : "Return Details"}
            </span>
            {s < 3 && <div className="w-8 h-px bg-sh-gray/30" />}
          </div>
        ))}
      </div>

      {/* Step 1: Search for Order */}
      {step === 1 && (
        <div className="bg-white p-6 rounded-lg shadow-md">
          <h2 className="text-lg font-semibold mb-4">Search for Order</h2>
          <div className="flex gap-2 mb-4">
            <div className="relative flex-1">
              <input
                type="text"
                value={orderSearchInput}
                onChange={(e) => setOrderSearchInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && searchOrders()}
                placeholder="Enter order number..."
                className="w-full border border-sh-gray/30 rounded-lg px-3 py-2.5 text-sm pr-10"
              />
              <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-sh-gray" />
            </div>
            <Button size="sm" onClick={searchOrders} disabled={searchLoading}>
              {searchLoading ? "Searching..." : "Search"}
            </Button>
          </div>

          {orderSearchResults.length > 0 && (
            <div className="border border-sh-gray/20 rounded-lg overflow-hidden">
              {orderSearchResults.map((order) => (
                <button
                  key={order.id}
                  onClick={() => handleSelectOrder(order)}
                  className="w-full text-left px-4 py-3 text-sm hover:bg-sh-linen border-b border-sh-gray/10 last:border-0 transition"
                >
                  <div className="flex justify-between items-center">
                    <div>
                      <span className="font-medium text-sh-blue">{order.orderno}</span>
                      {order.customer && (
                        <span className="text-sh-gray ml-3">
                          {order.customer.firstName} {order.customer.lastName}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-sh-gray">
                      {order.orderDate
                        ? format(parseLocalDate(order.orderDate), "MM/dd/yyyy")
                        : "-"}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}

          {orderLoading && <p className="text-sm text-sh-gray mt-3">Loading order details...</p>}
        </div>
      )}

      {/* Step 2: Select Line Item */}
      {step === 2 && selectedOrder && (
        <div className="bg-white p-6 rounded-lg shadow-md">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-semibold">
              Select Item from Order {selectedOrder.orderno}
            </h2>
            <Button size="sm" variant="outline" onClick={() => setStep(1)}>
              Change Order
            </Button>
          </div>

          {selectedOrder.customer && (
            <p className="text-sm text-sh-gray mb-4">
              Customer: {selectedOrder.customer.firstName} {selectedOrder.customer.lastName}
            </p>
          )}

          <div className="space-y-2 mb-4">
            {selectedOrder.lineItems.map((item) => (
              <label
                key={item.id}
                className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition ${
                  selectedLineItemId === item.id
                    ? "border-sh-blue bg-sh-blue/5"
                    : "border-sh-gray/20 hover:border-sh-gray/40"
                }`}
              >
                <input
                  type="radio"
                  name="lineItem"
                  checked={selectedLineItemId === item.id}
                  onChange={() => setSelectedLineItemId(item.id)}
                  className="accent-sh-blue"
                />
                <div className="flex-1 text-sm">
                  <p className="font-medium">{item.productName}</p>
                  <p className="text-sh-gray">
                    {item.partNo && `Part # ${item.partNo}`}
                    {item.partNo && " | "}
                    Qty: {item.orderedQuantity} | {formatCurrency(item.netPrice)}
                  </p>
                </div>
              </label>
            ))}
          </div>

          <Button size="sm" onClick={handleLineItemSelected} disabled={!selectedLineItemId}>
            Continue
          </Button>
        </div>
      )}

      {/* Step 3: Return Details */}
      {step === 3 && selectedOrder && selectedLineItem && (
        <div className="bg-white p-6 rounded-lg shadow-md">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-semibold">Return Details</h2>
            <Button size="sm" variant="outline" onClick={() => setStep(2)}>
              Change Item
            </Button>
          </div>

          <div className="bg-sh-linen rounded-lg p-3 mb-4 text-sm">
            <p>
              <span className="font-medium">Order:</span> {selectedOrder.orderno}
            </p>
            <p>
              <span className="font-medium">Item:</span> {selectedLineItem.productName}
              {selectedLineItem.partNo && ` (${selectedLineItem.partNo})`}
            </p>
          </div>

          <div className="space-y-4">
            {/* Reason */}
            <div>
              <label htmlFor="return-reason" className="block text-sm font-medium mb-1">
                Reason <span className="text-red-600">*</span>
              </label>
              <select
                id="return-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="w-full border border-sh-gray/30 rounded-lg px-3 py-2.5 text-sm"
              >
                <option value="">Select a reason...</option>
                {REASON_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Reason Notes */}
            <div>
              <label htmlFor="return-notes" className="block text-sm font-medium mb-1">
                Notes
              </label>
              <textarea
                id="return-notes"
                value={reasonNotes}
                onChange={(e) => setReasonNotes(e.target.value)}
                rows={3}
                className="w-full border border-sh-gray/30 rounded-lg px-3 py-2.5 text-sm"
                placeholder="Additional details about the return..."
              />
            </div>

            {/* Quantity */}
            <div>
              <label htmlFor="return-quantity" className="block text-sm font-medium mb-1">
                Quantity
              </label>
              <input
                id="return-quantity"
                type="number"
                min={1}
                max={selectedLineItem.orderedQuantity}
                value={quantity}
                onChange={(e) => setQuantity(Number.parseInt(e.target.value, 10) || 1)}
                className="w-32 border border-sh-gray/30 rounded-lg px-3 py-2.5 text-sm"
              />
              <p className="text-xs text-sh-gray mt-1">Max: {selectedLineItem.orderedQuantity}</p>
            </div>

            {/* Pickup Required */}
            <div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={pickupRequired}
                  onChange={(e) => setPickupRequired(e.target.checked)}
                  className="accent-sh-blue w-4 h-4"
                />
                <span className="text-sm font-medium">Pickup required</span>
              </label>
            </div>

            {/* Pickup details */}
            {pickupRequired && (
              <div className="border-l-2 border-sh-blue/20 pl-4 space-y-4">
                {/* Address */}
                <div>
                  <label htmlFor="pickup-address" className="block text-sm font-medium mb-1">
                    Pickup Address <span className="text-red-600">*</span>
                  </label>
                  {selectedOrder.customer?.addresses &&
                  selectedOrder.customer.addresses.length > 0 ? (
                    <select
                      id="pickup-address"
                      value={pickupAddressId}
                      onChange={(e) =>
                        setPickupAddressId(e.target.value ? Number(e.target.value) : "")
                      }
                      className="w-full border border-sh-gray/30 rounded-lg px-3 py-2.5 text-sm"
                    >
                      <option value="">Select address...</option>
                      {selectedOrder.customer.addresses.map((addr) => (
                        <option key={addr.id} value={addr.id}>
                          {addr.address1}
                          {addr.address2 ? `, ${addr.address2}` : ""}, {addr.city}, {addr.state}{" "}
                          {addr.zip}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <p className="text-sm text-sh-gray">No addresses on file for this customer.</p>
                  )}
                </div>

                {/* Date */}
                <div>
                  <label htmlFor="pickup-date" className="block text-sm font-medium mb-1">
                    Pickup Date
                  </label>
                  <input
                    id="pickup-date"
                    type="date"
                    value={pickupDate}
                    onChange={(e) => setPickupDate(e.target.value)}
                    className="w-full border border-sh-gray/30 rounded-lg px-3 py-2.5 text-sm"
                  />
                </div>

                {/* Time Slot */}
                <div>
                  <label htmlFor="pickup-timeslot" className="block text-sm font-medium mb-1">
                    Time Slot
                  </label>
                  <select
                    id="pickup-timeslot"
                    value={pickupTimeSlot}
                    onChange={(e) => setPickupTimeSlot(e.target.value)}
                    className="w-full border border-sh-gray/30 rounded-lg px-3 py-2.5 text-sm"
                  >
                    <option value="">Select time slot...</option>
                    {TIME_SLOTS.map((slot) => (
                      <option key={slot.value} value={slot.value}>
                        {slot.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {/* Submit */}
            <div className="pt-4 border-t border-sh-gray/10 flex gap-2">
              <Button onClick={handleSubmit} disabled={submitting || !reason}>
                {submitting ? "Submitting..." : "Submit Return"}
              </Button>
              <Link href="/app/sales/returns">
                <Button variant="outline">Cancel</Button>
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
