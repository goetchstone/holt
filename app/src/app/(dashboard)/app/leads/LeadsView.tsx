"use client";

// /app/src/app/(dashboard)/app/leads/LeadsView.tsx
//
// Leads kanban board with filters, needs-attention strip, generate-from-campaign
// and manual-add modals. App Router port of the legacy pages/leads/index.tsx body
// (minus MainLayout chrome, which comes from the (dashboard) layout). Reads the
// shared /api/leads* + /api/mailchimp/campaigns + /api/staff REST endpoints. Role
// gating (leadScore / wealthTier only for managers) preserved via useSession.

import { useState, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";
import axios from "axios";
import { toast } from "react-toastify";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";

type LeadTier = "HOT" | "WARM" | "COOL" | "NEW";
type Staleness = "active" | "going_stale" | "expired";

type LeadRow = {
  id: number;
  source: string;
  status: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  sourceDetail: string | null;
  campaignId: string | null;
  assignedToId: number | null;
  assignedAt: string | null;
  salesOrderId: number | null;
  notes: string | null;
  created: string;
  pinned: boolean;
  lastActionAt: string | null;
  customer: {
    id: number;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
  } | null;
  assignedTo: { id: number; displayName: string } | null;
  salesOrder: { id: number; orderno: string } | null;
  isExistingCustomer: boolean;
  hasOrders: boolean;
  orderCount: number;
  totalSpend: number;
  lastSalesperson: string | null;
  campaignSubject: string | null;
  leadTier: LeadTier | null;
  leadScore?: number;
  wealthTier?: string | null;
  recentEngagement: {
    lastOpenAt: string | null;
    lastClickAt: string | null;
    campaignCount30d: number;
  };
  staleness: Staleness;
  daysSinceLastAction: number | null;
  suggestedAction: { key: string; label: string } | null;
};

type NeedsAttention = {
  newToAssign: number;
  goingStale: number;
  hotNoContact: number;
};

type StaffOption = { id: number; displayName: string };
type CampaignOption = { id: string; name: string | null; subject: string | null };

type CurrencyFormatter = (amount: number) => string;

const BOARD_COLUMNS = ["NEW", "ASSIGNED", "CONTACTED", "QUALIFIED"] as const;

const STATUS_LABELS: Record<string, string> = {
  NEW: "New",
  ASSIGNED: "Assigned",
  CONTACTED: "Contacted",
  QUALIFIED: "Qualified",
  CONVERTED: "Converted",
  LOST: "Lost",
};

const SOURCE_BADGE: Record<string, { bg: string; label: string }> = {
  MAILCHIMP_CLICK: { bg: "bg-sh-blue/10 text-sh-blue", label: "Email Click" },
  MAILCHIMP_OPEN: { bg: "bg-sh-blue/5 text-sh-blue/70", label: "Email Open" },
  WALK_IN: { bg: "bg-sh-gold/20 text-sh-gold", label: "Walk-in" },
  PHONE: { bg: "bg-green-100 text-green-800", label: "Phone" },
  REFERRAL: { bg: "bg-purple-100 text-purple-800", label: "Referral" },
  WEBSITE: { bg: "bg-blue-100 text-blue-800", label: "Website" },
  OTHER: { bg: "bg-sh-gray/10 text-sh-gray", label: "Other" },
};

// Plain-English temperature pills. Designers see these instead of numbers.
const TIER_PILL: Record<LeadTier, { bg: string; label: string; emoji: string }> = {
  HOT: { bg: "bg-red-100 text-red-800 border-red-200", label: "Hot", emoji: "🔥" },
  WARM: { bg: "bg-amber-100 text-amber-800 border-amber-200", label: "Warm", emoji: "🙂" },
  COOL: { bg: "bg-blue-100 text-blue-800 border-blue-200", label: "Cool", emoji: "🙃" },
  NEW: { bg: "bg-sh-gray/10 text-sh-gray border-sh-gray/20", label: "New", emoji: "😐" },
};

const ALL_STATUSES = ["NEW", "ASSIGNED", "CONTACTED", "QUALIFIED", "CONVERTED", "LOST"];

// Leads with total spend at or above this threshold get a "hot" visual indicator
const HOT_LEAD_SPEND_THRESHOLD = 5000;

function daysSince(dateStr: string): number {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  return Math.floor((now - then) / 86400000);
}

function leadDisplayName(lead: LeadRow): string {
  if (lead.customer) {
    const parts = [lead.customer.firstName, lead.customer.lastName].filter(Boolean);
    if (parts.length > 0) return parts.join(" ");
  }
  const parts = [lead.firstName, lead.lastName].filter(Boolean);
  if (parts.length > 0) return parts.join(" ");
  return lead.email || "Unknown";
}

export function LeadsView() {
  const { data: session } = useSession();
  const userRole = (session as any)?.role || "DESIGNER";
  const isManager = userRole === "MANAGER" || userRole === "ADMIN" || userRole === "SUPER_ADMIN";

  const money = useMoneyFormatter();
  const formatCurrency: CurrencyFormatter = (amount) => money(amount, { whole: true });

  const [leads, setLeads] = useState<LeadRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignOption[]>([]);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  // Filters
  const [filterAssignedTo, setFilterAssignedTo] = useState<string>("");
  const [filterSource, setFilterSource] = useState<string>("");
  const [filterHot, setFilterHot] = useState(false);
  const [filterTier, setFilterTier] = useState<LeadTier | "">("");

  // Needs-attention counts (manager-only)
  const [needsAttention, setNeedsAttention] = useState<NeedsAttention | null>(null);

  // Campaign modal
  const [showCampaignModal, setShowCampaignModal] = useState(false);
  const [selectedCampaignId, setSelectedCampaignId] = useState<string>("");
  const [generating, setGenerating] = useState(false);

  // Manual lead modal
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createForm, setCreateForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    source: "WALK_IN",
    notes: "",
  });
  const [creating, setCreating] = useState(false);

  const fetchLeads = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = { limit: "500" };
      if (filterAssignedTo) params.assignedToId = filterAssignedTo;
      if (filterSource) params.source = filterSource;
      const res = await axios.get("/api/leads", { params });
      setLeads(res.data.data);
    } catch {
      toast.error("Failed to load leads");
    } finally {
      setLoading(false);
    }
  }, [filterAssignedTo, filterSource]);

  useEffect(() => {
    fetchLeads();
  }, [fetchLeads]);

  // Load the "Needs Attention" counts for managers
  useEffect(() => {
    if (!isManager) return;
    axios
      .get<NeedsAttention>("/api/leads/needs-attention")
      .then((res) => setNeedsAttention(res.data))
      .catch(() => {
        /* non-critical — just hide the strip */
      });
  }, [isManager, leads.length]); // refresh when leads change

  async function togglePin(lead: LeadRow) {
    try {
      await axios.put(`/api/leads/${lead.id}`, { pinned: !lead.pinned });
      toast.success(lead.pinned ? "Unpinned" : "Pinned — won't auto-archive");
      fetchLeads();
    } catch {
      toast.error("Failed to pin.");
    }
  }

  useEffect(() => {
    const loadStaff = async () => {
      try {
        const res = await axios.get("/api/staff", { params: { limit: 200 } });
        const list = res.data.staff || res.data || [];
        setStaff(
          list
            .filter((s: { isActive: boolean; role: string }) => s.isActive)
            .map((s: { id: number; displayName: string }) => ({
              id: s.id,
              displayName: s.displayName,
            })),
        );
      } catch {
        // Non-critical
      }
    };
    loadStaff();
  }, []);

  useEffect(() => {
    const loadCampaigns = async () => {
      try {
        const res = await axios.get("/api/mailchimp/campaigns");
        const list = Array.isArray(res.data) ? res.data : res.data.campaigns || [];
        setCampaigns(list);
      } catch {
        // Non-critical
      }
    };
    loadCampaigns();
  }, []);

  const handleStatusChange = async (lead: LeadRow, newStatus: string) => {
    try {
      await axios.put(`/api/leads/${lead.id}`, { status: newStatus });
      setLeads((prev) => prev.map((l) => (l.id === lead.id ? { ...l, status: newStatus } : l)));
    } catch {
      toast.error("Failed to update status");
    }
  };

  const handleAssign = async (lead: LeadRow, staffId: number | null) => {
    try {
      await axios.put(`/api/leads/${lead.id}`, { assignedToId: staffId });
      await fetchLeads();
    } catch {
      toast.error("Failed to assign lead");
    }
  };

  const handleNotesUpdate = async (leadId: number, notes: string) => {
    try {
      await axios.put(`/api/leads/${leadId}`, { notes });
      setLeads((prev) => prev.map((l) => (l.id === leadId ? { ...l, notes } : l)));
      toast.success("Notes saved");
    } catch {
      toast.error("Failed to save notes");
    }
  };

  const handleGenerateFromCampaign = async () => {
    if (!selectedCampaignId) return;
    setGenerating(true);
    try {
      const res = await axios.post("/api/leads/from-campaign", {
        campaignId: selectedCampaignId,
      });
      toast.success(`Created ${res.data.created} leads (${res.data.autoAssigned} auto-assigned)`);
      setShowCampaignModal(false);
      setSelectedCampaignId("");
      fetchLeads();
    } catch {
      toast.error("Failed to generate leads");
    } finally {
      setGenerating(false);
    }
  };

  const handleCreateLead = async () => {
    setCreating(true);
    try {
      await axios.post("/api/leads", createForm);
      toast.success("Lead created");
      setShowCreateModal(false);
      setCreateForm({
        firstName: "",
        lastName: "",
        email: "",
        phone: "",
        source: "WALK_IN",
        notes: "",
      });
      fetchLeads();
    } catch {
      toast.error("Failed to create lead");
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (leadId: number) => {
    try {
      await axios.delete(`/api/leads/${leadId}`);
      setLeads((prev) => prev.filter((l) => l.id !== leadId));
      toast.success("Lead deleted");
    } catch {
      toast.error("Failed to delete lead");
    }
  };

  // Separate board leads from archived (converted/lost). Filters: Hot
  // (tier=HOT OR legacy $5k spend), tier (explicit), going-stale chip.
  const hotFilter = (l: LeadRow) => {
    if (filterHot) {
      return l.leadTier === "HOT" || (l.hasOrders && l.totalSpend >= HOT_LEAD_SPEND_THRESHOLD);
    }
    return true;
  };
  const tierFilter = (l: LeadRow) => !filterTier || l.leadTier === filterTier;
  const boardLeads = leads.filter(
    (l) =>
      BOARD_COLUMNS.includes(l.status as (typeof BOARD_COLUMNS)[number]) &&
      hotFilter(l) &&
      tierFilter(l),
  );
  const archivedLeads = leads.filter(
    (l) => (l.status === "CONVERTED" || l.status === "LOST") && hotFilter(l) && tierFilter(l),
  );

  return (
    <>
      <div className="py-2 space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl text-sh-blue font-semibold font-serif">Leads</h1>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowCampaignModal(true)}
              className="px-4 py-2.5 bg-sh-blue text-white rounded-lg text-sm font-medium
                         hover:bg-sh-navy transition min-h-[44px]"
            >
              Generate from Campaign
            </button>
            <button
              onClick={() => setShowCreateModal(true)}
              className="px-4 py-2.5 border border-sh-blue text-sh-blue rounded-lg text-sm
                         font-medium hover:bg-sh-blue/5 transition min-h-[44px]"
            >
              Add Lead
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <label htmlFor="lead-filter-assigned" className="text-sm text-sh-gray">
              Assigned to
            </label>
            <select
              id="lead-filter-assigned"
              value={filterAssignedTo}
              onChange={(e) => setFilterAssignedTo(e.target.value)}
              className="border border-sh-gray/30 rounded-lg px-3 py-2 text-sm min-h-[44px]"
            >
              <option value="">All</option>
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.displayName}
                </option>
              ))}
            </select>
          </div>
          <button
            onClick={() => setFilterHot((v) => !v)}
            className={`px-4 py-2 rounded-lg text-sm font-medium min-h-[44px] transition ${
              filterHot
                ? "bg-sh-gold text-white"
                : "border border-sh-gray/30 text-sh-gray hover:border-sh-gold hover:text-sh-gold"
            }`}
          >
            Hot Leads
          </button>
          <div className="flex items-center gap-2">
            <label htmlFor="lead-filter-source" className="text-sm text-sh-gray">
              Source
            </label>
            <select
              id="lead-filter-source"
              value={filterSource}
              onChange={(e) => setFilterSource(e.target.value)}
              className="border border-sh-gray/30 rounded-lg px-3 py-2 text-sm min-h-[44px]"
            >
              <option value="">All</option>
              {Object.entries(SOURCE_BADGE).map(([key, { label }]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Needs Attention strip (manager-only) */}
        {isManager && needsAttention && (
          <div className="bg-white border border-sh-gray/20 rounded-lg p-3">
            {needsAttention.newToAssign === 0 &&
            needsAttention.goingStale === 0 &&
            needsAttention.hotNoContact === 0 ? (
              <p className="text-sm text-green-700 font-medium">✓ All caught up. Nice work.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {needsAttention.newToAssign > 0 && (
                  <button
                    onClick={() => {
                      setFilterTier("");
                      setFilterHot(false);
                      setFilterAssignedTo("");
                    }}
                    className="px-3 py-1.5 text-sm rounded-full border border-sh-blue/40 text-sh-blue hover:bg-sh-blue hover:text-white transition"
                    title="New leads nobody's been assigned"
                  >
                    {needsAttention.newToAssign} new to assign
                  </button>
                )}
                {needsAttention.goingStale > 0 && (
                  <button
                    onClick={() => setFilterTier("")}
                    className="px-3 py-1.5 text-sm rounded-full border border-amber-300 text-amber-700 hover:bg-amber-500 hover:text-white transition"
                    title="Leads untouched 14+ days — auto-archive after 30"
                  >
                    {needsAttention.goingStale} going stale
                  </button>
                )}
                {needsAttention.hotNoContact > 0 && (
                  <button
                    onClick={() => setFilterTier("HOT")}
                    className="px-3 py-1.5 text-sm rounded-full border border-red-200 text-red-700 hover:bg-red-500 hover:text-white transition"
                  >
                    {needsAttention.hotNoContact} hot with no contact
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Tier filter pills (all roles) */}
        <div className="flex flex-wrap gap-2">
          {(["HOT", "WARM", "COOL", "NEW"] as LeadTier[]).map((tier) => {
            const active = filterTier === tier;
            const pill = TIER_PILL[tier];
            return (
              <button
                key={tier}
                onClick={() => setFilterTier(active ? "" : tier)}
                className={`px-3 py-1.5 text-xs rounded-full border transition ${
                  active
                    ? pill.bg.replace(/bg-\S+ /g, "bg-sh-blue ") + " text-white border-sh-blue"
                    : pill.bg
                }`}
              >
                {pill.emoji} {pill.label} only
              </button>
            );
          })}
          {filterTier && (
            <button
              onClick={() => setFilterTier("")}
              className="px-3 py-1.5 text-xs text-sh-gray hover:underline"
            >
              Clear
            </button>
          )}
        </div>

        {/* Kanban Board */}
        {loading ? (
          <p className="text-sh-gray text-sm py-8 text-center">Loading leads...</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            {BOARD_COLUMNS.map((col) => {
              const colLeads = boardLeads.filter((l) => l.status === col);
              return (
                <div key={col} className="bg-sh-linen rounded-lg p-3 min-h-[200px]">
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="text-sm font-semibold text-sh-blue font-serif">
                      {STATUS_LABELS[col]}
                    </h2>
                    <span className="text-xs text-sh-gray bg-white rounded-full px-2 py-0.5">
                      {colLeads.length}
                    </span>
                  </div>
                  <div className="space-y-2">
                    {colLeads.map((lead) => (
                      <LeadCard
                        key={lead.id}
                        lead={lead}
                        isManager={isManager}
                        isExpanded={expandedId === lead.id}
                        staff={staff}
                        formatCurrency={formatCurrency}
                        onToggle={() => setExpandedId(expandedId === lead.id ? null : lead.id)}
                        onStatusChange={handleStatusChange}
                        onAssign={handleAssign}
                        onNotesUpdate={handleNotesUpdate}
                        onDelete={handleDelete}
                        onTogglePin={togglePin}
                      />
                    ))}
                    {colLeads.length === 0 && (
                      <p className="text-xs text-sh-gray/50 text-center py-4">No leads</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Archived section */}
        {archivedLeads.length > 0 && (
          <div className="mt-6">
            <h2 className="text-lg text-sh-blue font-semibold font-serif mb-3">Converted / Lost</h2>
            <div className="bg-white rounded-lg border border-sh-gray/20 divide-y divide-sh-gray/10">
              {archivedLeads.map((lead) => (
                <div key={lead.id} className="px-4 py-3 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full ${
                        lead.status === "CONVERTED"
                          ? "bg-green-100 text-green-800"
                          : "bg-red-100 text-red-800"
                      }`}
                    >
                      {STATUS_LABELS[lead.status]}
                    </span>
                    <span className="text-sm text-sh-black">{leadDisplayName(lead)}</span>
                    {lead.salesOrder && (
                      <span className="text-xs text-sh-gray">Order {lead.salesOrder.orderno}</span>
                    )}
                  </div>
                  <span className="text-xs text-sh-gray">{daysSince(lead.created)}d ago</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Generate from Campaign Modal */}
      {showCampaignModal && (
        <ModalOverlay onClose={() => setShowCampaignModal(false)}>
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md">
            <h2 className="text-lg font-semibold text-sh-blue font-serif mb-4">
              Generate Leads from Campaign
            </h2>
            <p className="text-sm text-sh-gray mb-4">
              Creates a lead for each unique email that clicked a link in the selected campaign.
              Existing customers are auto-assigned to their primary designer.
            </p>
            <select
              value={selectedCampaignId}
              onChange={(e) => setSelectedCampaignId(e.target.value)}
              className="w-full border border-sh-gray/30 rounded-lg px-3 py-2.5 text-sm mb-4
                         min-h-[44px]"
            >
              <option value="">Select a campaign...</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.subject || c.name || c.id}
                </option>
              ))}
            </select>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowCampaignModal(false)}
                className="px-4 py-2.5 text-sm text-sh-gray hover:text-sh-black transition
                           min-h-[44px]"
              >
                Cancel
              </button>
              <button
                onClick={handleGenerateFromCampaign}
                disabled={!selectedCampaignId || generating}
                className="px-4 py-2.5 bg-sh-blue text-white rounded-lg text-sm font-medium
                           hover:bg-sh-navy transition disabled:opacity-50 min-h-[44px]"
              >
                {generating ? "Generating..." : "Generate"}
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}

      {/* Create Lead Modal */}
      {showCreateModal && (
        <ModalOverlay onClose={() => setShowCreateModal(false)}>
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md">
            <h2 className="text-lg font-semibold text-sh-blue font-serif mb-4">Add Lead</h2>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <input
                  placeholder="First name"
                  value={createForm.firstName}
                  onChange={(e) => setCreateForm((f) => ({ ...f, firstName: e.target.value }))}
                  className="border border-sh-gray/30 rounded-lg px-3 py-2.5 text-sm min-h-[44px]"
                />
                <input
                  placeholder="Last name"
                  value={createForm.lastName}
                  onChange={(e) => setCreateForm((f) => ({ ...f, lastName: e.target.value }))}
                  className="border border-sh-gray/30 rounded-lg px-3 py-2.5 text-sm min-h-[44px]"
                />
              </div>
              <input
                placeholder="Email"
                type="email"
                value={createForm.email}
                onChange={(e) => setCreateForm((f) => ({ ...f, email: e.target.value }))}
                className="w-full border border-sh-gray/30 rounded-lg px-3 py-2.5 text-sm
                           min-h-[44px]"
              />
              <input
                placeholder="Phone"
                value={createForm.phone}
                onChange={(e) => setCreateForm((f) => ({ ...f, phone: e.target.value }))}
                className="w-full border border-sh-gray/30 rounded-lg px-3 py-2.5 text-sm
                           min-h-[44px]"
              />
              <select
                value={createForm.source}
                onChange={(e) => setCreateForm((f) => ({ ...f, source: e.target.value }))}
                className="w-full border border-sh-gray/30 rounded-lg px-3 py-2.5 text-sm
                           min-h-[44px]"
              >
                {Object.entries(SOURCE_BADGE).map(([key, { label }]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
              <textarea
                placeholder="Notes"
                value={createForm.notes}
                onChange={(e) => setCreateForm((f) => ({ ...f, notes: e.target.value }))}
                rows={3}
                className="w-full border border-sh-gray/30 rounded-lg px-3 py-2.5 text-sm"
              />
            </div>
            <div className="flex justify-end gap-3 mt-4">
              <button
                onClick={() => setShowCreateModal(false)}
                className="px-4 py-2.5 text-sm text-sh-gray hover:text-sh-black transition
                           min-h-[44px]"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateLead}
                disabled={creating}
                className="px-4 py-2.5 bg-sh-blue text-white rounded-lg text-sm font-medium
                           hover:bg-sh-navy transition disabled:opacity-50 min-h-[44px]"
              >
                {creating ? "Creating..." : "Create"}
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}
    </>
  );
}

// -- Lead Card Component --

function LeadCard({
  lead,
  isManager,
  isExpanded,
  staff,
  formatCurrency,
  onToggle,
  onStatusChange,
  onAssign,
  onNotesUpdate,
  onDelete,
  onTogglePin,
}: {
  lead: LeadRow;
  isManager: boolean;
  isExpanded: boolean;
  staff: StaffOption[];
  formatCurrency: CurrencyFormatter;
  onToggle: () => void;
  onStatusChange: (lead: LeadRow, status: string) => void;
  onAssign: (lead: LeadRow, staffId: number | null) => void;
  onNotesUpdate: (leadId: number, notes: string) => void;
  onDelete: (leadId: number) => void;
  onTogglePin: (lead: LeadRow) => void;
}) {
  const [editNotes, setEditNotes] = useState(lead.notes || "");
  const badge = SOURCE_BADGE[lead.source] || SOURCE_BADGE.OTHER;
  const days = daysSince(lead.created);
  const isHot = lead.leadTier === "HOT";
  const tierPill = lead.leadTier ? TIER_PILL[lead.leadTier] : null;

  // Show campaign subject for mailchimp leads instead of generic source badge
  const displaySource = lead.campaignSubject || badge.label;

  const engagementBlurb = (() => {
    const e = lead.recentEngagement;
    if (!e || e.campaignCount30d === 0) return null;
    const latest = e.lastClickAt || e.lastOpenAt;
    if (!latest) return null;
    const d = daysSince(latest);
    const verb = e.lastClickAt ? "Last click" : "Last open";
    return `${e.campaignCount30d} email${e.campaignCount30d === 1 ? "" : "s"} · ${verb} ${d === 0 ? "today" : d + "d ago"}`;
  })();

  return (
    <div
      className={`bg-white rounded-lg shadow-sm ${
        isHot ? "border-2 border-red-300" : "border border-sh-gray/15"
      }`}
    >
      {/* Going-stale / expired strip */}
      {lead.staleness === "going_stale" && (
        <div className="bg-amber-50 border-b border-amber-200 px-3 py-1 text-xs text-amber-800 flex items-center justify-between">
          <span>Going stale · no action in {lead.daysSinceLastAction ?? "?"} days</span>
          {isManager && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onTogglePin(lead);
              }}
              className="text-xs underline"
              title={lead.pinned ? "Unpin" : "Pin to keep — won't auto-archive"}
            >
              {lead.pinned ? "📌 Pinned" : "Pin to keep"}
            </button>
          )}
        </div>
      )}
      {lead.pinned && lead.staleness !== "going_stale" && (
        <div className="bg-sh-blue/5 border-b border-sh-blue/20 px-3 py-1 text-xs text-sh-blue">
          📌 Pinned — exempt from auto-archive
        </div>
      )}

      <button onClick={onToggle} className="w-full text-left p-3 min-h-[44px]">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-sm font-medium text-sh-black truncate">{leadDisplayName(lead)}</p>
              {tierPill && (
                <span
                  className={`text-xs px-1.5 py-0.5 rounded-full border ${tierPill.bg} font-medium whitespace-nowrap`}
                >
                  {tierPill.emoji} {tierPill.label}
                  {isManager && lead.leadScore !== undefined && (
                    <span className="ml-1 opacity-70">{lead.leadScore}</span>
                  )}
                </span>
              )}
              {lead.wealthTier && isManager && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-sh-gold/15 text-sh-gold font-medium">
                  {lead.wealthTier.replace(/_/g, " ")}
                </span>
              )}
            </div>
            {lead.email && lead.customer && (
              <p className="text-xs text-sh-gray truncate">{lead.email}</p>
            )}
          </div>
          <span className="text-xs text-sh-gray whitespace-nowrap">{days}d</span>
        </div>
        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
          <span
            className={`text-xs px-2 py-0.5 rounded-full ${
              lead.isExistingCustomer ? "bg-sh-gold/15 text-sh-gold" : "bg-sh-gray/10 text-sh-gray"
            }`}
          >
            {lead.isExistingCustomer ? "Existing Customer" : "New Contact"}
          </span>
          <span className={`text-xs px-2 py-0.5 rounded-full ${badge.bg} truncate max-w-[160px]`}>
            {displaySource}
          </span>
          {lead.assignedTo && (
            <span className="text-xs text-sh-gray truncate">{lead.assignedTo.displayName}</span>
          )}
        </div>
        {lead.hasOrders && (
          <div className="flex items-center gap-3 mt-1.5 text-xs text-sh-gray">
            <span>
              {lead.orderCount} order{lead.orderCount !== 1 ? "s" : ""}
            </span>
            <span>{formatCurrency(lead.totalSpend)}</span>
            {lead.lastSalesperson && <span>Last: {lead.lastSalesperson}</span>}
          </div>
        )}
        {engagementBlurb && <p className="text-xs text-sh-blue mt-1.5">📬 {engagementBlurb}</p>}
        {lead.suggestedAction && (
          <p className="text-xs text-sh-gold mt-1.5 font-medium">→ {lead.suggestedAction.label}</p>
        )}
      </button>

      {isExpanded && (
        <div className="border-t border-sh-gray/10 p-3 space-y-3">
          {lead.sourceDetail && <p className="text-xs text-sh-gray">{lead.sourceDetail}</p>}
          {lead.phone && <p className="text-xs text-sh-gray">Phone: {lead.phone}</p>}

          {/* Status dropdown */}
          <div>
            <label htmlFor={`lead-status-${lead.id}`} className="text-xs text-sh-gray block mb-1">
              Status
            </label>
            <select
              id={`lead-status-${lead.id}`}
              value={lead.status}
              onChange={(e) => onStatusChange(lead, e.target.value)}
              className="w-full border border-sh-gray/30 rounded-lg px-2 py-2 text-sm
                         min-h-[44px]"
            >
              {ALL_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </div>

          {/* Assignment (managers only) */}
          {isManager && (
            <div>
              <label htmlFor={`lead-assign-${lead.id}`} className="text-xs text-sh-gray block mb-1">
                Assign to
              </label>
              <select
                id={`lead-assign-${lead.id}`}
                value={lead.assignedToId ?? ""}
                onChange={(e) =>
                  onAssign(lead, e.target.value ? Number.parseInt(e.target.value) : null)
                }
                className="w-full border border-sh-gray/30 rounded-lg px-2 py-2 text-sm
                           min-h-[44px]"
              >
                <option value="">Unassigned</option>
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.displayName}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Notes */}
          <div>
            <label htmlFor={`lead-notes-${lead.id}`} className="text-xs text-sh-gray block mb-1">
              Notes
            </label>
            <textarea
              id={`lead-notes-${lead.id}`}
              value={editNotes}
              onChange={(e) => setEditNotes(e.target.value)}
              rows={2}
              className="w-full border border-sh-gray/30 rounded-lg px-2 py-2 text-sm"
            />
            {editNotes !== (lead.notes || "") && (
              <button
                onClick={() => onNotesUpdate(lead.id, editNotes)}
                className="mt-1 text-xs text-sh-blue hover:underline min-h-[44px] px-2"
              >
                Save notes
              </button>
            )}
          </div>

          {/* Link to order if converted */}
          {lead.salesOrder && (
            <a
              href={`/app/sales/orders/${lead.salesOrder.id}`}
              className="block text-xs text-sh-blue hover:underline"
            >
              View Order {lead.salesOrder.orderno}
            </a>
          )}

          {/* Delete (managers only) */}
          {isManager && (
            <button
              onClick={() => {
                if (
                  globalThis.confirm(
                    `Delete lead "${leadDisplayName(lead)}"? This cannot be undone.`,
                  )
                ) {
                  onDelete(lead.id);
                }
              }}
              className="text-xs text-red-600 hover:text-red-800 transition min-h-[44px] px-2"
            >
              Delete lead
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// -- Modal Overlay --

function ModalOverlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-sh-black/40"
        role="presentation"
        onClick={onClose}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      />
      <div className="relative z-10">{children}</div>
    </div>
  );
}
