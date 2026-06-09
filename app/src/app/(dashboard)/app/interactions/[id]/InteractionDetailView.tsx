"use client";

// /app/src/app/(dashboard)/app/interactions/[id]/InteractionDetailView.tsx
//
// Customer interaction detail: link/create customer, notes, outcome, and
// start-quote / create-service-case actions. App Router port of the legacy
// pages/interactions/[id].tsx body (minus MainLayout chrome, which comes from the
// (dashboard) layout). Reads the shared /api/interactions/[id] + /api/customers
// REST endpoints. The interaction id arrives as a prop from the server page.

import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import axios from "axios";
import { toast } from "react-toastify";
import Link from "next/link";
import { useCustomerSearch } from "@/hooks/useCustomerSearch";

type CustomerResult = {
  id: number;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  email: string | null;
};

type InteractionDetail = {
  id: number;
  staffMemberId: number;
  customerId: number | null;
  salesOrderId: number | null;
  storeLocation: string;
  source: string;
  outcome: string | null;
  notes: string | null;
  startedAt: string;
  endedAt: string | null;
  isActive: boolean;
  staffMember: { id: number; displayName: string; role: string };
  customer: {
    id: number;
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
    email: string | null;
  } | null;
  salesOrder: { id: number; orderno: string } | null;
};

const OUTCOMES: { value: string; label: string }[] = [
  { value: "BROWSING", label: "Browsing" },
  { value: "QUOTE_STARTED", label: "Quote Started" },
  { value: "SALE_COMPLETED", label: "Sale Completed" },
  { value: "APPOINTMENT_SET", label: "Appointment Set" },
  { value: "SERVICE_CASE", label: "Service Case" },
  { value: "RETURNED", label: "Returned" },
];

const SOURCE_LABELS: Record<string, string> = {
  WALK_IN: "Walk-in",
  PHONE: "Phone",
  EMAIL: "Email",
  APPOINTMENT: "Appointment",
};

const SOURCE_BADGE: Record<string, string> = {
  WALK_IN: "bg-sh-blue/10 text-sh-blue",
  PHONE: "bg-sh-gold/20 text-sh-gold",
  EMAIL: "bg-sh-gray/10 text-sh-gray",
  APPOINTMENT: "bg-green-100 text-green-800",
};

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  return `${diffDays}d ago`;
}

export function InteractionDetailView({ id }: { id: string }) {
  const [interaction, setInteraction] = useState<InteractionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState("");
  const [savingNotes, setSavingNotes] = useState(false);
  const [selectedOutcome, setSelectedOutcome] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);

  // Customer search
  const {
    query: customerSearch,
    setQuery: setCustomerSearch,
    results: customerResults,
    clear: clearCustomerSearch,
  } = useCustomerSearch({ limit: 10 });
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false);
  const customerDropdownRef = useRef<HTMLDivElement>(null);

  // New customer form
  const [showNewCustomer, setShowNewCustomer] = useState(false);
  const [newFirstName, setNewFirstName] = useState("");
  const [newLastName, setNewLastName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [creatingCustomer, setCreatingCustomer] = useState(false);

  const fetchInteraction = useCallback(async () => {
    if (!id) return;
    try {
      const res = await axios.get(`/api/interactions/${encodeURIComponent(id)}`);
      const data = res.data;
      setInteraction(data);
      setNotes(data.notes || "");
      setSelectedOutcome(data.outcome || null);
    } catch {
      toast.error("Failed to load interaction");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchInteraction();
  }, [fetchInteraction]);

  // Show dropdown when results arrive
  useEffect(() => {
    if (customerResults.length > 0) setShowCustomerDropdown(true);
  }, [customerResults]);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (customerDropdownRef.current && !customerDropdownRef.current.contains(e.target as Node)) {
        setShowCustomerDropdown(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleSaveNotes = async () => {
    if (!interaction) return;
    setSavingNotes(true);
    try {
      await axios.put(`/api/interactions/${interaction.id}`, {
        notes: notes.trim() || null,
      });
      toast.success("Notes saved");
      fetchInteraction();
    } catch {
      toast.error("Failed to save notes");
    } finally {
      setSavingNotes(false);
    }
  };

  const handleSetOutcome = async (outcome: string) => {
    if (!interaction) return;
    setSelectedOutcome(outcome);
    try {
      await axios.put(`/api/interactions/${interaction.id}`, { outcome });
      toast.success("Outcome updated");
      fetchInteraction();
    } catch {
      toast.error("Failed to update outcome");
      setSelectedOutcome(interaction.outcome || null);
    }
  };

  const handleLinkCustomer = async (customer: CustomerResult) => {
    if (!interaction) return;
    try {
      await axios.put(`/api/interactions/${interaction.id}`, {
        customerId: customer.id,
      });
      setShowCustomerDropdown(false);
      clearCustomerSearch();
      toast.success("Customer linked");
      fetchInteraction();
    } catch {
      toast.error("Failed to link customer");
    }
  };

  const handleCreateCustomer = async () => {
    if (!interaction || !newLastName.trim()) {
      toast.error("Last name is required");
      return;
    }
    setCreatingCustomer(true);
    try {
      const res = await axios.post("/api/customers", {
        firstName: newFirstName.trim() || null,
        lastName: newLastName.trim(),
        phone: newPhone.trim() || null,
        email: newEmail.trim() || null,
      });
      const newCustomer = res.data;
      await axios.put(`/api/interactions/${interaction.id}`, {
        customerId: newCustomer.id,
      });
      setShowNewCustomer(false);
      setNewFirstName("");
      setNewLastName("");
      setNewPhone("");
      setNewEmail("");
      toast.success("Customer created and linked");
      fetchInteraction();
    } catch {
      toast.error("Failed to create customer");
    } finally {
      setCreatingCustomer(false);
    }
  };

  const handleUnlinkCustomer = async () => {
    if (!interaction) return;
    try {
      await axios.put(`/api/interactions/${interaction.id}`, {
        customerId: null,
      });
      toast.success("Customer unlinked");
      fetchInteraction();
    } catch {
      toast.error("Failed to unlink customer");
    }
  };

  const handleEndInteraction = async () => {
    if (!interaction) return;
    setEnding(true);
    try {
      const payload: Record<string, unknown> = { isActive: false };
      if (selectedOutcome) payload.outcome = selectedOutcome;
      await axios.put(`/api/interactions/${interaction.id}`, payload);
      toast.success("Interaction ended");
      fetchInteraction();
    } catch {
      toast.error("Failed to end interaction");
    } finally {
      setEnding(false);
    }
  };

  if (loading) {
    return <p className="text-sh-gray py-8">Loading interaction...</p>;
  }

  if (!interaction) {
    return <p className="text-sh-gray py-8">Interaction not found.</p>;
  }

  const sourceBadge = SOURCE_BADGE[interaction.source] || "bg-sh-gray/10 text-sh-gray";
  const sourceLabel = SOURCE_LABELS[interaction.source] || interaction.source;

  return (
    <div className="py-2 space-y-6 font-serif">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-2xl text-sh-blue font-semibold">
            {interaction.staffMember.displayName}
          </h1>
          <span className={`text-xs px-2 py-1 rounded ${sourceBadge}`}>{sourceLabel}</span>
          <span className="text-sm text-sh-gray">{interaction.storeLocation}</span>
          <span className="text-sm text-sh-gray">
            Started {relativeTime(interaction.startedAt)}
          </span>
          {!interaction.isActive && (
            <span className="text-xs px-2 py-1 rounded bg-sh-gray/10 text-sh-gray">Ended</span>
          )}
        </div>
        <Link href="/app/interactions">
          <Button variant="outline" size="sm">
            Back to List
          </Button>
        </Link>
      </div>

      {/* Customer section */}
      <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-6">
        <h3 className="text-sm font-semibold text-sh-gray uppercase tracking-wide mb-3">
          Customer
        </h3>
        {interaction.customer ? (
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <Link
                href={`/app/sales/customers/${interaction.customer.id}`}
                className="font-medium text-sh-blue hover:underline"
              >
                {[interaction.customer.firstName, interaction.customer.lastName]
                  .filter(Boolean)
                  .join(" ")}
              </Link>
              {interaction.customer.phone && (
                <p className="text-sm text-sh-gray">{interaction.customer.phone}</p>
              )}
              {interaction.customer.email && (
                <p className="text-sm text-sh-gray">{interaction.customer.email}</p>
              )}
            </div>
            {interaction.isActive && (
              <button
                onClick={handleUnlinkCustomer}
                className="text-sm text-sh-gray hover:text-sh-blue min-h-[44px] px-3"
              >
                Change
              </button>
            )}
          </div>
        ) : (
          <div ref={customerDropdownRef} className="space-y-3">
            {!showNewCustomer ? (
              <>
                <input
                  type="text"
                  placeholder="Search by name or phone..."
                  value={customerSearch}
                  onChange={(e) => setCustomerSearch(e.target.value)}
                  className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
                />
                {showCustomerDropdown && customerResults.length > 0 && (
                  <div className="relative">
                    <div className="absolute z-20 top-0 left-0 right-0 bg-white border border-sh-gray/20 rounded shadow-lg max-h-48 overflow-y-auto">
                      {customerResults.map((c) => (
                        <button
                          key={c.id}
                          onClick={() => handleLinkCustomer(c)}
                          className="w-full text-left px-4 py-3 text-sm hover:bg-sh-linen transition min-h-[44px]"
                        >
                          <span className="font-medium">
                            {c.firstName} {c.lastName}
                          </span>
                          {c.phone && <span className="text-sh-gray ml-2">{c.phone}</span>}
                          {c.email && <span className="text-sh-gray ml-2">{c.email}</span>}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <button
                  onClick={() => setShowNewCustomer(true)}
                  className="text-sm text-sh-blue hover:underline min-h-[44px] px-1"
                >
                  New Customer
                </button>
              </>
            ) : (
              <div className="border border-sh-gray/20 rounded p-4 bg-sh-linen space-y-3">
                <h4 className="text-sm font-semibold text-sh-black">New Customer</h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="new-customer-first" className="block text-xs text-sh-gray mb-1">
                      First Name
                    </label>
                    <input
                      id="new-customer-first"
                      type="text"
                      value={newFirstName}
                      onChange={(e) => setNewFirstName(e.target.value)}
                      className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label htmlFor="new-customer-last" className="block text-xs text-sh-gray mb-1">
                      Last Name
                    </label>
                    <input
                      id="new-customer-last"
                      type="text"
                      value={newLastName}
                      onChange={(e) => setNewLastName(e.target.value)}
                      className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label htmlFor="new-customer-phone" className="block text-xs text-sh-gray mb-1">
                      Phone
                    </label>
                    <input
                      id="new-customer-phone"
                      type="tel"
                      value={newPhone}
                      onChange={(e) => setNewPhone(e.target.value)}
                      className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label htmlFor="new-customer-email" className="block text-xs text-sh-gray mb-1">
                      Email
                    </label>
                    <input
                      id="new-customer-email"
                      type="email"
                      value={newEmail}
                      onChange={(e) => setNewEmail(e.target.value)}
                      className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
                    />
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handleCreateCustomer}
                    disabled={creatingCustomer || !newLastName.trim()}
                  >
                    {creatingCustomer ? "Creating..." : "Create & Link"}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setShowNewCustomer(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Notes section */}
      <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-6">
        <h3 className="text-sm font-semibold text-sh-gray uppercase tracking-wide mb-3">Notes</h3>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={4}
          placeholder="Add notes about this interaction..."
          className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm mb-3"
          onBlur={() => {
            if (notes !== (interaction.notes || "")) handleSaveNotes();
          }}
        />
        <div className="flex justify-end">
          <Button
            variant="primary"
            size="sm"
            onClick={handleSaveNotes}
            disabled={savingNotes || notes === (interaction.notes || "")}
          >
            {savingNotes ? "Saving..." : "Save Notes"}
          </Button>
        </div>
      </div>

      {/* Outcome section */}
      <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-6">
        <h3 className="text-sm font-semibold text-sh-gray uppercase tracking-wide mb-3">Outcome</h3>
        <div className="flex flex-wrap gap-2">
          {OUTCOMES.map((o) => (
            <button
              key={o.value}
              onClick={() => handleSetOutcome(o.value)}
              className={`px-4 py-2 rounded-full text-sm font-medium transition min-h-[44px] ${
                selectedOutcome === o.value
                  ? "bg-sh-blue text-white shadow-md"
                  : "bg-sh-linen text-sh-black hover:bg-sh-gray/10 border border-sh-gray/20"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {/* Actions */}
      <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-6">
        <h3 className="text-sm font-semibold text-sh-gray uppercase tracking-wide mb-3">Actions</h3>
        <div className="flex flex-wrap gap-3">
          {interaction.customer && (
            <Link
              href={`/app/sales/quotes/new?customerId=${interaction.customer.id}&interactionId=${interaction.id}`}
              className="inline-flex"
            >
              <Button variant="primary" size="sm">
                Start Quote
              </Button>
            </Link>
          )}
          {!interaction.customer && (
            <Button variant="primary" size="sm" disabled title="Link a customer first">
              Start Quote
            </Button>
          )}
          {interaction.customer && (
            <Link
              href={`/app/service/cases/new?customerId=${interaction.customer.id}`}
              className="inline-flex"
            >
              <Button variant="outline" size="sm">
                Create Service Case
              </Button>
            </Link>
          )}
        </div>
      </div>

      {/* End Interaction */}
      {interaction.isActive && (
        <div className="flex justify-end">
          <Button variant="primary" onClick={handleEndInteraction} disabled={ending}>
            {ending ? "Ending..." : "End Interaction"}
          </Button>
        </div>
      )}

      {/* Ended info */}
      {!interaction.isActive && interaction.endedAt && (
        <div className="bg-sh-linen rounded-lg border border-sh-gray/20 p-4">
          <p className="text-sm text-sh-black">
            <span className="font-medium">Ended</span> {relativeTime(interaction.endedAt)}
            {interaction.outcome && (
              <span className="ml-2 text-sh-gray">
                --{" "}
                {OUTCOMES.find((o) => o.value === interaction.outcome)?.label ||
                  interaction.outcome}
              </span>
            )}
          </p>
        </div>
      )}
    </div>
  );
}
