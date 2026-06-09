"use client";

// /app/src/app/(dashboard)/app/service/ServiceView.tsx
//
// Service cases queue (tabs, filters, paginated table). App Router port of the
// legacy pages/service/index.tsx body (minus MainLayout chrome, which comes from
// the (dashboard) layout). Reads the shared /api/service/cases + settings +
// warehouse/locations + staff REST endpoints.

import { useState, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";
import axios from "axios";
import { toast } from "react-toastify";
import { format, formatDistanceToNowStrict } from "date-fns";
import Link from "next/link";
import { buildLastActionTitle } from "@/lib/serviceCaseLastAction";

// Trimmed CaseRow — the dashboard table shows only the columns the
// owner asked for (#, Customer, Status, Opened, Last Action,
// Assigned To). Other fields stay on the detail page.
type CaseRow = {
  id: number;
  caseNumber: string;
  created: string;
  /** MAX(case.created, latest note.created) computed server-side. Intentionally
   * excludes case.updated — Prisma's @updatedAt bumps that on every re-import
   * even when nothing semantically changed. See GET /api/service/cases for the
   * computation. */
  lastActionAt: string;
  /** Truncated one-line preview of the most recent comment, or null when the
   * case has no notes (so the only "action" was opening). Truncation lives in
   * `summarizeNoteText`; the full text is shown on hover via `title`. */
  lastActionText: string | null;
  /** authorDisplayName from the latest note (snapshot — preserves former-staff
   * names that no longer resolve to a current StaffMember). Null when the
   * case has no notes. */
  lastActionAuthor: string | null;
  status: { id: number; name: string; color: string | null; isClosed: boolean };
  customer: { id: number; firstName: string | null; lastName: string | null } | null;
  assignedTo: { id: number; displayName: string } | null;
};

type FilterOption = { id: number; name: string };
type LocationOption = { id: number; name: string };

const TABS = [
  { key: "all", label: "All" },
  { key: "mine", label: "My Cases" },
  { key: "open", label: "Open" },
  { key: "waiting", label: "Waiting" },
  { key: "completed", label: "Completed" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export function ServiceView() {
  const { data: session } = useSession();
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  // Default to Open so the queue doesn't drown in completed history.
  // Operators explicitly click "All" / "Completed" to see closed cases.
  const [activeTab, setActiveTab] = useState<TabKey>("open");
  const [typeFilter, setTypeFilter] = useState("");
  const [priorityFilter, setPriorityFilter] = useState("");
  const [locationFilter, setLocationFilter] = useState("");
  const [types, setTypes] = useState<FilterOption[]>([]);
  const [priorities, setPriorities] = useState<FilterOption[]>([]);
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [staffId, setStaffId] = useState<number | null>(null);
  // Owner direction 2026-05-27: keep the queue page-sized; default
  // to 10 rows + paginate. Eliminates the long-scroll on a 378-case
  // import.
  const limit = 10;

  useEffect(() => {
    const loadFilters = async () => {
      try {
        const [typesRes, prioritiesRes, locationsRes] = await Promise.all([
          axios.get("/api/service/settings/types"),
          axios.get("/api/service/settings/priorities"),
          axios.get("/api/warehouse/locations"),
        ]);
        setTypes(typesRes.data.types || []);
        setPriorities(prioritiesRes.data.priorities || []);
        setLocations(
          (locationsRes.data.locations || []).map((l: { id: number; name: string }) => ({
            id: l.id,
            name: l.name,
          })),
        );
      } catch {
        // Filters are optional; silently handle
      }
    };
    loadFilters();
  }, []);

  // Look up current user's staff ID for "My Cases" tab
  useEffect(() => {
    if (!session?.user?.email) return;
    const lookupStaff = async () => {
      try {
        const res = await axios.get("/api/staff?limit=100");
        const staff = (res.data.staff || []).find(
          (s: { email: string | null }) =>
            s.email && s.email.toLowerCase() === session.user?.email?.toLowerCase(),
        );
        if (staff) setStaffId(staff.id);
      } catch {
        // Non-critical
      }
    };
    lookupStaff();
  }, [session?.user?.email]);

  const fetchCases = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string | number> = { page, limit };
      if (search) params.search = search;
      if (typeFilter) params.typeId = typeFilter;
      if (priorityFilter) params.priorityId = priorityFilter;
      if (locationFilter) params.storeLocation = locationFilter;

      // Filter wiring matches the API: it reads `isClosed` as a
      // string "true"/"false" (per /api/service/cases/index.ts:33).
      // The previous shape (`isOpen=1` / `isClosed=1`) was a no-op
      // for Open and inverted for Completed — Sonar didn't catch it
      // because Prisma silently accepted the bad query string.
      if (activeTab === "mine" && staffId) {
        params.assignedToId = staffId;
      } else if (activeTab === "open") {
        params.isClosed = "false";
      } else if (activeTab === "waiting") {
        // "Waiting" is a sub-state of Open — the API doesn't have a
        // dedicated query yet, so for now treat it as Open. A future
        // enhancement can add status-name-prefix filtering.
        params.isClosed = "false";
      } else if (activeTab === "completed") {
        params.isClosed = "true";
      }

      const res = await axios.get("/api/service/cases", { params });
      setCases(res.data.cases || []);
      setTotal(res.data.total || 0);
    } catch {
      toast.error("Failed to load service cases");
    } finally {
      setLoading(false);
    }
  }, [page, search, activeTab, typeFilter, priorityFilter, locationFilter, staffId]);

  useEffect(() => {
    fetchCases();
  }, [fetchCases]);

  const handleTabChange = (tab: TabKey) => {
    setActiveTab(tab);
    setPage(1);
  };

  const totalPages = Math.ceil(total / limit);

  const badgeStyle = (color: string | null) => {
    if (!color) return "bg-sh-gray/10 text-sh-gray";
    return `text-white`;
  };

  return (
    <div className="py-2 space-y-4 font-serif">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl text-sh-blue font-semibold">Service Cases</h1>
        <div className="flex gap-2 items-center">
          <Link href="/app/reports/service" className="text-sm text-sh-gold hover:underline">
            View KPIs →
          </Link>
          <Link href="/app/service/cases/new">
            <Button variant="primary" size="sm">
              New Case
            </Button>
          </Link>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-sh-gray/20">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => handleTabChange(tab.key)}
            className={`px-4 py-2 text-sm font-medium transition border-b-2 -mb-px ${
              activeTab === tab.key
                ? "border-sh-blue text-sh-blue"
                : "border-transparent text-sh-gray hover:text-sh-black"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Search and filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <input
          type="text"
          placeholder="Search cases..."
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          className="border border-sh-gray/30 rounded px-3 py-2 text-sm w-64"
        />
        <select
          value={typeFilter}
          onChange={(e) => {
            setTypeFilter(e.target.value);
            setPage(1);
          }}
          className="border border-sh-gray/30 rounded px-3 py-2 text-sm"
        >
          <option value="">All Types</option>
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <select
          value={priorityFilter}
          onChange={(e) => {
            setPriorityFilter(e.target.value);
            setPage(1);
          }}
          className="border border-sh-gray/30 rounded px-3 py-2 text-sm"
        >
          <option value="">All Priorities</option>
          {priorities.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          value={locationFilter}
          onChange={(e) => {
            setLocationFilter(e.target.value);
            setPage(1);
          }}
          className="border border-sh-gray/30 rounded px-3 py-2 text-sm"
        >
          <option value="">All Locations</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-sh-linen text-sh-black">
              <tr>
                <th className="p-3 border-b font-medium">Case #</th>
                <th className="p-3 border-b font-medium">Customer</th>
                <th className="p-3 border-b font-medium">Status</th>
                <th className="p-3 border-b font-medium">Opened</th>
                <th className="p-3 border-b font-medium">Last Action</th>
                <th className="p-3 border-b font-medium">Assigned To</th>
              </tr>
            </thead>
            {loading ? (
              <tbody>
                <tr>
                  <td colSpan={6} className="p-4 text-center text-sh-gray">
                    Loading...
                  </td>
                </tr>
              </tbody>
            ) : cases.length === 0 ? (
              <tbody>
                <tr>
                  <td colSpan={6} className="p-4 text-center text-sh-gray">
                    No cases found
                  </td>
                </tr>
              </tbody>
            ) : (
              /* Each case is its OWN <tbody> grouping two rows: the field
               * row on top and the comment-preview row below. Striping +
               * hover live on the tbody so both rows share the background
               * color AND highlight together. Click on either row
               * navigates to the case. Multiple-tbody-per-table is valid
               * HTML — used here for the row-grouping semantic. */
              cases.map((c, i) => {
                const previewTitle = buildLastActionTitle(c.lastActionAuthor, c.lastActionText);
                return (
                  <tbody
                    key={c.id}
                    className={`${i % 2 === 0 ? "bg-white" : "bg-sh-stripe"} hover:bg-sh-linen transition`}
                  >
                    <tr>
                      <td className="p-3 font-medium text-sh-blue">
                        <Link
                          href={`/app/service/cases/${c.id}`}
                          className="hover:underline focus:underline focus:outline-none"
                        >
                          {c.caseNumber}
                        </Link>
                      </td>
                      <td className="p-3">
                        {c.customer
                          ? `${c.customer.firstName || ""} ${c.customer.lastName || ""}`.trim() ||
                            "--"
                          : "--"}
                      </td>
                      <td className="p-3">
                        <span
                          className={`text-xs px-2 py-0.5 rounded ${badgeStyle(c.status.color)}`}
                          style={c.status.color ? { backgroundColor: c.status.color } : undefined}
                        >
                          {c.status.name}
                        </span>
                      </td>
                      <td className="p-3 text-sh-gray whitespace-nowrap">
                        {format(new Date(c.created), "MMM d, yyyy")}
                      </td>
                      <td className="p-3 text-sh-gray whitespace-nowrap">
                        {formatDistanceToNowStrict(new Date(c.lastActionAt), { addSuffix: true })}
                      </td>
                      <td className="p-3">{c.assignedTo ? c.assignedTo.displayName : "--"}</td>
                    </tr>
                    <tr>
                      {/* Comment-preview row spans the full table width.
                       * Always renders so row heights stay uniform; shows a
                       * muted placeholder when the case has no comments. */}
                      <td
                        colSpan={6}
                        className="px-3 pt-0 pb-3 border-b text-sh-gray"
                        title={previewTitle}
                      >
                        {c.lastActionText ? (
                          <p className="text-xs italic text-sh-gray/90 line-clamp-2">
                            {c.lastActionAuthor ? (
                              <span className="not-italic font-medium text-sh-gray">
                                {c.lastActionAuthor}:{" "}
                              </span>
                            ) : null}
                            {c.lastActionText}
                          </p>
                        ) : (
                          <p className="text-xs italic text-sh-gray/50">No comments yet</p>
                        )}
                      </td>
                    </tr>
                  </tbody>
                );
              })
            )}
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-sh-gray/10">
            <span className="text-sm text-sh-gray">
              Page {page} of {totalPages} ({total} cases)
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
