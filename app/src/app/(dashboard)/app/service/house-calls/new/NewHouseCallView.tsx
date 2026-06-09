"use client";

// /app/src/app/(dashboard)/app/service/house-calls/new/NewHouseCallView.tsx
//
// New house call form (customer + order search, saved/manual address,
// scheduling, assignment). App Router port of the legacy
// pages/service/house-calls/new.tsx body (minus MainLayout chrome, which comes
// from the (dashboard) layout). Reads the shared /api/service/house-calls +
// staff + warehouse/locations + customers + sales/orders REST endpoints.

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import axios from "axios";
import { toast } from "react-toastify";

interface Customer {
  id: number;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
}

interface CustomerAddress {
  id: number;
  street: string;
  city: string;
  state: string;
  zip: string;
  label: string | null;
}

interface Order {
  id: number;
  orderno: string;
  orderDate: string;
}

interface StaffMember {
  id: number;
  name: string;
}

interface Location {
  id: number;
  name: string;
}

const DURATION_OPTIONS = [
  { value: "1", label: "1 hour" },
  { value: "1.5", label: "1.5 hours" },
  { value: "2", label: "2 hours" },
  { value: "3", label: "3 hours" },
];

export function NewHouseCallView() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  // Customer search
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerResults, setCustomerResults] = useState<Customer[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [customerAddresses, setCustomerAddresses] = useState<CustomerAddress[]>([]);
  const [searching, setSearching] = useState(false);

  // Order search
  const [orderSearch, setOrderSearch] = useState("");
  const [orderResults, setOrderResults] = useState<Order[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [searchingOrders, setSearchingOrders] = useState(false);

  // Form fields
  const [addressId, setAddressId] = useState<string>("");
  const [manualAddress, setManualAddress] = useState({
    street: "",
    city: "",
    state: "",
    zip: "",
  });
  const [useManualAddress, setUseManualAddress] = useState(false);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [duration, setDuration] = useState("");
  const [designerId, setDesignerId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [scope, setScope] = useState("");
  const [specialInstructions, setSpecialInstructions] = useState("");

  // Lookups
  const [designers, setDesigners] = useState<StaffMember[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);

  const loadLookups = useCallback(async () => {
    try {
      const [designerRes, locationRes] = await Promise.all([
        axios.get("/api/staff"),
        axios.get("/api/warehouse/locations"),
      ]);
      const allStaff = Array.isArray(designerRes.data)
        ? designerRes.data
        : designerRes.data.staff || [];
      setDesigners(
        allStaff
          .filter(
            (s: any) =>
              s.role === "DESIGNER" ||
              s.role === "MANAGER" ||
              s.role === "ADMIN" ||
              s.role === "SUPER_ADMIN",
          )
          .map((s: any) => ({ id: s.id, name: s.displayName })),
      );
      setLocations(locationRes.data.locations || []);
    } catch {
      // Lookups failed silently; dropdowns will be empty
    }
  }, []);

  useEffect(() => {
    loadLookups();
  }, [loadLookups]);

  // Customer search with debounce
  useEffect(() => {
    if (customerSearch.length < 2) {
      setCustomerResults([]);
      return;
    }
    const timeout = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await axios.get("/api/customers", {
          params: { search: customerSearch, limit: 10 },
        });
        setCustomerResults(res.data.customers || []);
      } catch {
        setCustomerResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timeout);
  }, [customerSearch]);

  // Load addresses when customer is selected
  useEffect(() => {
    if (!selectedCustomer) {
      setCustomerAddresses([]);
      return;
    }
    const loadAddresses = async () => {
      try {
        const res = await axios.get(`/api/customers/${selectedCustomer.id}/addresses`);
        setCustomerAddresses(res.data.addresses || []);
      } catch {
        setCustomerAddresses([]);
      }
    };
    loadAddresses();
  }, [selectedCustomer]);

  // Order search with debounce
  useEffect(() => {
    if (orderSearch.length < 2) {
      setOrderResults([]);
      return;
    }
    const timeout = setTimeout(async () => {
      setSearchingOrders(true);
      try {
        const params: Record<string, string> = { search: orderSearch, limit: "10" };
        if (selectedCustomer) params.customerId = String(selectedCustomer.id);
        const res = await axios.get("/api/sales/orders", { params });
        setOrderResults(res.data.orders || []);
      } catch {
        setOrderResults([]);
      } finally {
        setSearchingOrders(false);
      }
    }, 300);
    return () => clearTimeout(timeout);
  }, [orderSearch, selectedCustomer]);

  const selectCustomer = (customer: Customer) => {
    setSelectedCustomer(customer);
    setCustomerSearch("");
    setCustomerResults([]);
    setAddressId("");
    setUseManualAddress(false);
  };

  const selectOrder = (order: Order) => {
    setSelectedOrder(order);
    setOrderSearch("");
    setOrderResults([]);
  };

  const handleSubmit = async () => {
    if (!selectedCustomer) {
      toast.error("Please select a customer");
      return;
    }
    if (!date || !time) {
      toast.error("Date and time are required");
      return;
    }

    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        customerId: selectedCustomer.id,
        scheduledDate: date,
        scheduledTime: time,
        duration: duration ? Number.parseFloat(duration) : null,
        designerId: designerId ? Number.parseInt(designerId) : null,
        locationId: locationId ? Number.parseInt(locationId) : null,
        scope: scope || null,
        specialInstructions: specialInstructions || null,
        orderId: selectedOrder?.id || null,
      };

      if (useManualAddress && manualAddress.street) {
        payload.address = manualAddress;
      } else if (addressId) {
        payload.addressId = Number.parseInt(addressId);
      }

      await axios.post("/api/service/house-calls", payload);
      toast.success("House call created");
      router.push("/app/service/house-calls");
    } catch (error: unknown) {
      const message =
        axios.isAxiosError(error) && error.response?.data?.error
          ? error.response.data.error
          : "Failed to create house call";
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="py-2 space-y-6 font-serif">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl text-sh-blue font-semibold">New House Call</h1>
        <Button variant="outline" onClick={() => router.push("/app/service/house-calls")}>
          Back to List
        </Button>
      </div>

      {/* Customer */}
      <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-6">
        <h2 className="text-lg font-semibold text-sh-black mb-4">Customer</h2>
        {selectedCustomer ? (
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sh-black font-medium">
                {selectedCustomer.firstName} {selectedCustomer.lastName}
              </p>
              {selectedCustomer.email && (
                <p className="text-sm text-sh-gray">{selectedCustomer.email}</p>
              )}
              {selectedCustomer.phone && (
                <p className="text-sm text-sh-gray">{selectedCustomer.phone}</p>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSelectedCustomer(null);
                setCustomerAddresses([]);
                setAddressId("");
              }}
            >
              Change
            </Button>
          </div>
        ) : (
          <div className="relative">
            <input
              type="text"
              className="border border-sh-gray/30 rounded px-3 py-2 text-sm w-full"
              placeholder="Search customers by name, email, or phone..."
              value={customerSearch}
              onChange={(e) => setCustomerSearch(e.target.value)}
            />
            {searching && <p className="text-xs text-sh-gray mt-1">Searching...</p>}
            {customerResults.length > 0 && (
              <div className="absolute z-10 mt-1 w-full bg-white border border-sh-gray/20 rounded-lg shadow-lg max-h-[240px] overflow-y-auto">
                {customerResults.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="w-full text-left px-4 py-3 hover:bg-sh-stripe border-b border-sh-gray/10 last:border-0"
                    onClick={() => selectCustomer(c)}
                  >
                    <p className="text-sm font-medium text-sh-black">
                      {c.firstName} {c.lastName}
                    </p>
                    <p className="text-xs text-sh-gray">
                      {[c.email, c.phone].filter(Boolean).join(" -- ")}
                    </p>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Order (optional) */}
      <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-6">
        <h2 className="text-lg font-semibold text-sh-black mb-4">Order (Optional)</h2>
        {selectedOrder ? (
          <div className="flex items-center justify-between">
            <p className="text-sh-black font-medium">Order #{selectedOrder.orderno}</p>
            <Button variant="outline" size="sm" onClick={() => setSelectedOrder(null)}>
              Remove
            </Button>
          </div>
        ) : (
          <div className="relative">
            <input
              type="text"
              className="border border-sh-gray/30 rounded px-3 py-2 text-sm w-full"
              placeholder="Search by order number..."
              value={orderSearch}
              onChange={(e) => setOrderSearch(e.target.value)}
            />
            {searchingOrders && <p className="text-xs text-sh-gray mt-1">Searching...</p>}
            {orderResults.length > 0 && (
              <div className="absolute z-10 mt-1 w-full bg-white border border-sh-gray/20 rounded-lg shadow-lg max-h-[200px] overflow-y-auto">
                {orderResults.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    className="w-full text-left px-4 py-3 hover:bg-sh-stripe border-b border-sh-gray/10 last:border-0"
                    onClick={() => selectOrder(o)}
                  >
                    <p className="text-sm font-medium text-sh-black">#{o.orderno}</p>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Address */}
      <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-6">
        <h2 className="text-lg font-semibold text-sh-black mb-4">Address</h2>
        {selectedCustomer && customerAddresses.length > 0 && !useManualAddress && (
          <div className="space-y-3">
            <select
              className="border border-sh-gray/30 rounded px-3 py-2 text-sm w-full"
              value={addressId}
              onChange={(e) => setAddressId(e.target.value)}
            >
              <option value="">Select an address...</option>
              {customerAddresses.map((addr) => (
                <option key={addr.id} value={addr.id}>
                  {addr.label ? `${addr.label}: ` : ""}
                  {addr.street}, {addr.city}, {addr.state} {addr.zip}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="text-sm text-sh-blue hover:underline"
              onClick={() => setUseManualAddress(true)}
            >
              Enter address manually
            </button>
          </div>
        )}
        {(useManualAddress || !selectedCustomer || customerAddresses.length === 0) && (
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-sh-gray mb-1">Street</label>
              <input
                type="text"
                className="border border-sh-gray/30 rounded px-3 py-2 text-sm w-full"
                value={manualAddress.street}
                onChange={(e) => setManualAddress((a) => ({ ...a, street: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-sh-gray mb-1">City</label>
                <input
                  type="text"
                  className="border border-sh-gray/30 rounded px-3 py-2 text-sm w-full"
                  value={manualAddress.city}
                  onChange={(e) => setManualAddress((a) => ({ ...a, city: e.target.value }))}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-sh-gray mb-1">State</label>
                <input
                  type="text"
                  className="border border-sh-gray/30 rounded px-3 py-2 text-sm w-full"
                  value={manualAddress.state}
                  onChange={(e) => setManualAddress((a) => ({ ...a, state: e.target.value }))}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-sh-gray mb-1">ZIP</label>
                <input
                  type="text"
                  className="border border-sh-gray/30 rounded px-3 py-2 text-sm w-full"
                  value={manualAddress.zip}
                  onChange={(e) => setManualAddress((a) => ({ ...a, zip: e.target.value }))}
                />
              </div>
            </div>
            {selectedCustomer && customerAddresses.length > 0 && (
              <button
                type="button"
                className="text-sm text-sh-blue hover:underline"
                onClick={() => {
                  setUseManualAddress(false);
                  setManualAddress({ street: "", city: "", state: "", zip: "" });
                }}
              >
                Select from saved addresses
              </button>
            )}
          </div>
        )}
      </div>

      {/* Scheduling */}
      <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-6">
        <h2 className="text-lg font-semibold text-sh-black mb-4">Scheduling</h2>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-medium text-sh-gray mb-1">Date</label>
            <input
              type="date"
              className="border border-sh-gray/30 rounded px-3 py-2 text-sm w-full"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-sh-gray mb-1">Time</label>
            <input
              type="time"
              className="border border-sh-gray/30 rounded px-3 py-2 text-sm w-full"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-sh-gray mb-1">Duration</label>
            <select
              className="border border-sh-gray/30 rounded px-3 py-2 text-sm w-full"
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
            >
              <option value="">Select duration...</option>
              {DURATION_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Assignment */}
      <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-6">
        <h2 className="text-lg font-semibold text-sh-black mb-4">Assignment</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-sh-gray mb-1">Designer</label>
            <select
              className="border border-sh-gray/30 rounded px-3 py-2 text-sm w-full"
              value={designerId}
              onChange={(e) => setDesignerId(e.target.value)}
            >
              <option value="">Select designer...</option>
              {designers.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-sh-gray mb-1">Showroom</label>
            <select
              className="border border-sh-gray/30 rounded px-3 py-2 text-sm w-full"
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
            >
              <option value="">Select showroom...</option>
              {locations.map((loc) => (
                <option key={loc.id} value={loc.id}>
                  {loc.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Details */}
      <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-6">
        <h2 className="text-lg font-semibold text-sh-black mb-4">Details</h2>
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-sh-gray mb-1">Scope of Work</label>
            <textarea
              className="border border-sh-gray/30 rounded px-3 py-2 text-sm w-full"
              rows={3}
              placeholder="Describe the scope of work..."
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-sh-gray mb-1">
              Special Instructions
            </label>
            <textarea
              className="border border-sh-gray/30 rounded px-3 py-2 text-sm w-full"
              rows={3}
              placeholder="Any special instructions or notes..."
              value={specialInstructions}
              onChange={(e) => setSpecialInstructions(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* Submit */}
      <div className="flex justify-end gap-3">
        <Button variant="outline" onClick={() => router.push("/app/service/house-calls")}>
          Cancel
        </Button>
        <Button disabled={submitting} onClick={handleSubmit}>
          {submitting ? "Creating..." : "Create House Call"}
        </Button>
      </div>
    </div>
  );
}
