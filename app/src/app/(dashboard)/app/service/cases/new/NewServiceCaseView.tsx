"use client";

// /app/src/app/(dashboard)/app/service/cases/new/NewServiceCaseView.tsx
//
// New service case form (customer + order search, case details, assignment).
// App Router port of the legacy pages/service/cases/new.tsx body (minus
// MainLayout chrome, which comes from the (dashboard) layout). Reads the shared
// /api/service/cases + settings + staff + warehouse/locations + sales/orders
// REST endpoints.

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import axios from "axios";
import { toast } from "react-toastify";
import { useCustomerSearch } from "@/hooks/useCustomerSearch";

type CustomerResult = {
  id: number;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  email: string | null;
};

type OrderResult = {
  id: number;
  orderno: string;
  vendor?: { id: number; name: string } | null;
};

type OptionItem = { id: number; name: string; firstName?: string; lastName?: string };

const CONTACT_METHODS = ["Phone", "Email", "Text"];

export function NewServiceCaseView() {
  const router = useRouter();
  const [saving, setSaving] = useState(false);

  // Customer search
  const {
    query: customerSearch,
    setQuery: setCustomerSearch,
    results: customerResults,
    clear: clearCustomerSearch,
  } = useCustomerSearch({ limit: 10 });
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerResult | null>(null);
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(true);
  const customerDropdownRef = useRef<HTMLDivElement>(null);

  // Order search
  const [orderSearch, setOrderSearch] = useState("");
  const [orderResults, setOrderResults] = useState<OrderResult[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<OrderResult | null>(null);
  const [showOrderDropdown, setShowOrderDropdown] = useState(false);
  const orderDropdownRef = useRef<HTMLDivElement>(null);

  // Options
  const [types, setTypes] = useState<OptionItem[]>([]);
  const [priorities, setPriorities] = useState<OptionItem[]>([]);
  const [staff, setStaff] = useState<OptionItem[]>([]);
  const [locations, setLocations] = useState<OptionItem[]>([]);

  // Form fields
  const [typeId, setTypeId] = useState("");
  const [priorityId, setPriorityId] = useState("");
  const [summary, setSummary] = useState("");
  const [itemDescription, setItemDescription] = useState("");
  const [partNo, setPartNo] = useState("");
  const [assignedToId, setAssignedToId] = useState("");
  const [storeLocation, setStoreLocation] = useState("");
  const [preferredContact, setPreferredContact] = useState("");
  const [initialNote, setInitialNote] = useState("");

  useEffect(() => {
    const loadOptions = async () => {
      try {
        const [typesRes, prioritiesRes, staffRes, locationsRes] = await Promise.all([
          axios.get("/api/service/settings/types"),
          axios.get("/api/service/settings/priorities"),
          axios.get("/api/staff?limit=100"),
          axios.get("/api/warehouse/locations"),
        ]);
        setTypes(typesRes.data.types || []);
        setPriorities(prioritiesRes.data.priorities || []);
        setStaff(staffRes.data.staff || []);
        setLocations(
          (locationsRes.data.locations || []).map((l: { id: number; name: string }) => ({
            id: l.id,
            name: l.name,
          })),
        );

        // Default to first active type and priority
        const activeTypes = (typesRes.data.types || []).filter(
          (t: OptionItem & { isActive?: boolean }) => t.isActive !== false,
        );
        const activePriorities = (prioritiesRes.data.priorities || []).filter(
          (p: OptionItem & { isActive?: boolean }) => p.isActive !== false,
        );
        if (activeTypes.length > 0) setTypeId(String(activeTypes[0].id));
        if (activePriorities.length > 0) setPriorityId(String(activePriorities[0].id));
      } catch {
        toast.error("Failed to load form options");
      }
    };
    loadOptions();
  }, []);

  // Order search with debounce
  useEffect(() => {
    if (orderSearch.length < 2) {
      setOrderResults([]);
      return;
    }
    const timeout = setTimeout(async () => {
      try {
        const res = await axios.get("/api/sales/orders", {
          params: { search: orderSearch, limit: 10 },
        });
        setOrderResults(res.data.orders || []);
        setShowOrderDropdown(true);
      } catch {
        // Silently handle
      }
    }, 300);
    return () => clearTimeout(timeout);
  }, [orderSearch]);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (customerDropdownRef.current && !customerDropdownRef.current.contains(e.target as Node)) {
        setShowCustomerDropdown(false);
      }
      if (orderDropdownRef.current && !orderDropdownRef.current.contains(e.target as Node)) {
        setShowOrderDropdown(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleSubmit = async () => {
    if (!typeId || !priorityId || !summary.trim()) {
      toast.error("Type, priority, and summary are required");
      return;
    }

    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        typeId: Number.parseInt(typeId),
        priorityId: Number.parseInt(priorityId),
        summary: summary.trim(),
      };

      if (selectedCustomer) payload.customerId = selectedCustomer.id;
      if (selectedOrder) payload.salesOrderId = selectedOrder.id;
      if (assignedToId) payload.assignedToId = Number.parseInt(assignedToId);
      if (storeLocation) payload.storeLocation = storeLocation;
      if (preferredContact) payload.preferredContact = preferredContact;
      if (itemDescription.trim()) payload.itemDescription = itemDescription.trim();
      if (partNo.trim()) payload.partNo = partNo.trim();
      if (initialNote.trim()) payload.initialNote = initialNote.trim();

      const res = await axios.post("/api/service/cases", payload);
      toast.success("Service case created");
      router.push(`/app/service/cases/${res.data.id}`);
    } catch (err: unknown) {
      const message =
        axios.isAxiosError(err) && err.response?.data?.error
          ? err.response.data.error
          : "Failed to create case";
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="py-2 space-y-6 font-serif">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl text-sh-blue font-semibold">New Service Case</h1>
      </div>

      <div className="space-y-6">
        {/* Customer Section */}
        <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-6">
          <h2 className="text-lg font-semibold text-sh-black mb-4">Customer</h2>
          <div ref={customerDropdownRef} className="relative">
            {selectedCustomer ? (
              <div className="flex items-center justify-between bg-sh-linen rounded px-4 py-3">
                <div>
                  <p className="font-medium text-sh-black">
                    {selectedCustomer.firstName} {selectedCustomer.lastName}
                  </p>
                  <p className="text-sm text-sh-gray">
                    {[selectedCustomer.phone, selectedCustomer.email].filter(Boolean).join(" | ")}
                  </p>
                </div>
                <button
                  onClick={() => {
                    setSelectedCustomer(null);
                    clearCustomerSearch();
                  }}
                  className="text-sm text-sh-gray hover:text-sh-blue"
                >
                  Change
                </button>
              </div>
            ) : (
              <>
                <input
                  type="text"
                  placeholder="Search by customer name..."
                  value={customerSearch}
                  onChange={(e) => setCustomerSearch(e.target.value)}
                  className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
                />
                {showCustomerDropdown && customerResults.length > 0 && (
                  <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-white border border-sh-gray/20 rounded shadow-lg max-h-48 overflow-y-auto">
                    {customerResults.map((c) => (
                      <button
                        key={c.id}
                        onClick={() => {
                          setSelectedCustomer(c as CustomerResult);
                          setShowCustomerDropdown(false);
                          clearCustomerSearch();
                        }}
                        className="w-full text-left px-4 py-2 text-sm hover:bg-sh-linen transition"
                      >
                        <span className="font-medium">
                          {c.firstName} {c.lastName}
                        </span>
                        {c.email && <span className="text-sh-gray ml-2">{c.email}</span>}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Order Section */}
        <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-6">
          <h2 className="text-lg font-semibold text-sh-black mb-4">Order (optional)</h2>
          <div ref={orderDropdownRef} className="relative">
            {selectedOrder ? (
              <div className="flex items-center justify-between bg-sh-linen rounded px-4 py-3">
                <div>
                  <p className="font-medium text-sh-black">Order #{selectedOrder.orderno}</p>
                  {selectedOrder.vendor && (
                    <p className="text-sm text-sh-gray">{selectedOrder.vendor.name}</p>
                  )}
                </div>
                <button
                  onClick={() => {
                    setSelectedOrder(null);
                    setOrderSearch("");
                  }}
                  className="text-sm text-sh-gray hover:text-sh-blue"
                >
                  Change
                </button>
              </div>
            ) : (
              <>
                <input
                  type="text"
                  placeholder="Search by order number..."
                  value={orderSearch}
                  onChange={(e) => setOrderSearch(e.target.value)}
                  className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
                />
                {showOrderDropdown && orderResults.length > 0 && (
                  <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-white border border-sh-gray/20 rounded shadow-lg max-h-48 overflow-y-auto">
                    {orderResults.map((o) => (
                      <button
                        key={o.id}
                        onClick={() => {
                          setSelectedOrder(o);
                          setShowOrderDropdown(false);
                          setOrderSearch("");
                        }}
                        className="w-full text-left px-4 py-2 text-sm hover:bg-sh-linen transition"
                      >
                        <span className="font-medium">#{o.orderno}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Case Details Section */}
        <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-6">
          <h2 className="text-lg font-semibold text-sh-black mb-4">Case Details</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-sh-gray mb-1">Type</label>
              <select
                value={typeId}
                onChange={(e) => setTypeId(e.target.value)}
                className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
              >
                <option value="">Select type...</option>
                {types.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm text-sh-gray mb-1">Priority</label>
              <select
                value={priorityId}
                onChange={(e) => setPriorityId(e.target.value)}
                className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
              >
                <option value="">Select priority...</option>
                {priorities.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="mt-4">
            <label className="block text-sm text-sh-gray mb-1">Summary</label>
            <textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              rows={3}
              className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
              placeholder="Describe the issue..."
            />
          </div>
        </div>

        {/* Item Info Section */}
        <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-6">
          <h2 className="text-lg font-semibold text-sh-black mb-4">Item Info (optional)</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-sh-gray mb-1">Item Description</label>
              <input
                type="text"
                value={itemDescription}
                onChange={(e) => setItemDescription(e.target.value)}
                className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm text-sh-gray mb-1">Part Number</label>
              <input
                type="text"
                value={partNo}
                onChange={(e) => setPartNo(e.target.value)}
                className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
              />
            </div>
          </div>
        </div>

        {/* Assignment Section */}
        <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-6">
          <h2 className="text-lg font-semibold text-sh-black mb-4">Assignment</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm text-sh-gray mb-1">Assigned To</label>
              <select
                value={assignedToId}
                onChange={(e) => setAssignedToId(e.target.value)}
                className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
              >
                <option value="">Unassigned</option>
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.firstName} {s.lastName}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm text-sh-gray mb-1">Store Location</label>
              <select
                value={storeLocation}
                onChange={(e) => setStoreLocation(e.target.value)}
                className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
              >
                <option value="">Select location...</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.name}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm text-sh-gray mb-1">Preferred Contact</label>
              <select
                value={preferredContact}
                onChange={(e) => setPreferredContact(e.target.value)}
                className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
              >
                <option value="">Select...</option>
                {CONTACT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Initial Note */}
        <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-6">
          <h2 className="text-lg font-semibold text-sh-black mb-4">Initial Note</h2>
          <textarea
            value={initialNote}
            onChange={(e) => setInitialNote(e.target.value)}
            rows={4}
            className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
            placeholder="Add any initial notes..."
          />
        </div>

        {/* Actions */}
        <div className="flex gap-3">
          <Button variant="primary" onClick={handleSubmit} disabled={saving}>
            {saving ? "Creating..." : "Create Case"}
          </Button>
          <Button variant="outline" onClick={() => router.push("/app/service")}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
