"use client";

// /app/src/app/(dashboard)/app/interactions/InteractionsView.tsx
//
// Customer interactions list with tab filters (active / mine / all / completed)
// and pagination. App Router port of the legacy pages/interactions/index.tsx body
// (minus MainLayout chrome, which comes from the (dashboard) layout). Reads the
// shared /api/interactions + /api/staff REST endpoints.

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import axios from "axios";
import { toast } from "react-toastify";

type InteractionRow = {
  id: number;
  staffMemberId: number;
  storeLocation: string;
  source: string;
  outcome: string | null;
  notes: string | null;
  startedAt: string;
  endedAt: string | null;
  isActive: boolean;
  staffMember: { id: number; displayName: string };
  customer: { id: number; firstName: string | null; lastName: string | null } | null;
};

type Tab = "active" | "mine" | "all" | "completed";

const SOURCE_BADGE: Record<string, { bg: string; label: string }> = {
  WALK_IN: { bg: "bg-sh-blue/10 text-sh-blue", label: "Walk-in" },
  PHONE: { bg: "bg-sh-gold/20 text-sh-gold", label: "Phone" },
  EMAIL: { bg: "bg-sh-gray/10 text-sh-gray", label: "Email" },
  APPOINTMENT: { bg: "bg-green-100 text-green-800", label: "Appointment" },
};

const OUTCOME_BADGE: Record<string, { bg: string; label: string }> = {
  BROWSING: { bg: "bg-sh-gray/10 text-sh-gray", label: "Browsing" },
  QUOTE_STARTED: { bg: "bg-sh-gold/20 text-sh-gold", label: "Quote" },
  SALE_COMPLETED: { bg: "bg-green-100 text-green-800", label: "Sale" },
  APPOINTMENT_SET: { bg: "bg-blue-100 text-blue-800", label: "Appt Set" },
  SERVICE_CASE: { bg: "bg-yellow-100 text-yellow-800", label: "Service" },
  RETURNED: { bg: "bg-red-100 text-red-800", label: "Return" },
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

export function InteractionsView() {
  const router = useRouter();
  const { data: session } = useSession();
  const [interactions, setInteractions] = useState<InteractionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("active");
  const [myStaffId, setMyStaffId] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  useEffect(() => {
    if (!session?.user?.email) return;
    const findMyStaff = async () => {
      try {
        const res = await axios.get("/api/staff", { params: { limit: 200 } });
        const staffList = res.data.staff || res.data || [];
        const me = staffList.find((s: { email: string | null }) => s.email === session.user?.email);
        if (me) setMyStaffId(me.id);
      } catch {
        // Non-critical
      }
    };
    findMyStaff();
  }, [session?.user?.email]);

  const fetchInteractions = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string | number> = { page, limit: 25 };

      if (tab === "active") {
        params.isActive = "true";
      } else if (tab === "mine" && myStaffId) {
        params.staffMemberId = myStaffId;
      } else if (tab === "completed") {
        params.isActive = "false";
      }

      const res = await axios.get("/api/interactions", { params });
      setInteractions(res.data.data || []);
      setTotalPages(res.data.totalPages || 1);
    } catch {
      toast.error("Failed to load interactions");
    } finally {
      setLoading(false);
    }
  }, [tab, myStaffId, page]);

  useEffect(() => {
    fetchInteractions();
  }, [fetchInteractions]);

  useEffect(() => {
    setPage(1);
  }, [tab]);

  const tabs: { key: Tab; label: string }[] = [
    { key: "active", label: "Active" },
    { key: "mine", label: "My Interactions" },
    { key: "all", label: "All" },
    { key: "completed", label: "Completed" },
  ];

  return (
    <div className="py-2 space-y-4 font-serif">
      <h1 className="text-2xl text-sh-blue font-semibold">Customer Interactions</h1>

      {/* Tab filters */}
      <div className="flex gap-1 border-b border-sh-gray/20">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-3 text-sm font-medium transition-colors min-h-[44px] ${
              tab === t.key
                ? "text-sh-blue border-b-2 border-sh-blue"
                : "text-sh-gray hover:text-sh-black"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Table */}
      {loading ? (
        <p className="text-sh-gray py-8 text-sm">Loading interactions...</p>
      ) : interactions.length === 0 ? (
        <p className="text-sh-gray py-8 text-sm">No interactions found.</p>
      ) : (
        <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-sh-gray/20 bg-sh-linen">
                  <th className="text-left px-4 py-3 text-sh-gray font-medium text-xs uppercase tracking-wide">
                    Staff
                  </th>
                  <th className="text-left px-4 py-3 text-sh-gray font-medium text-xs uppercase tracking-wide">
                    Customer
                  </th>
                  <th className="text-left px-4 py-3 text-sh-gray font-medium text-xs uppercase tracking-wide">
                    Store
                  </th>
                  <th className="text-left px-4 py-3 text-sh-gray font-medium text-xs uppercase tracking-wide">
                    Source
                  </th>
                  <th className="text-left px-4 py-3 text-sh-gray font-medium text-xs uppercase tracking-wide">
                    Started
                  </th>
                  <th className="text-left px-4 py-3 text-sh-gray font-medium text-xs uppercase tracking-wide">
                    Outcome
                  </th>
                  <th className="text-left px-4 py-3 text-sh-gray font-medium text-xs uppercase tracking-wide">
                    Notes
                  </th>
                </tr>
              </thead>
              <tbody>
                {interactions.map((ix, idx) => {
                  const sourceCfg = SOURCE_BADGE[ix.source] || {
                    bg: "bg-sh-gray/10 text-sh-gray",
                    label: ix.source,
                  };
                  const outcomeCfg = ix.outcome
                    ? OUTCOME_BADGE[ix.outcome] || {
                        bg: "bg-sh-gray/10 text-sh-gray",
                        label: ix.outcome,
                      }
                    : null;

                  const customerName = ix.customer
                    ? [ix.customer.firstName, ix.customer.lastName].filter(Boolean).join(" ")
                    : "Walk-in";

                  return (
                    <tr
                      key={ix.id}
                      onClick={() => router.push(`/app/interactions/${ix.id}`)}
                      className={`border-b border-sh-gray/10 cursor-pointer hover:bg-sh-linen transition-colors ${
                        idx % 2 === 1 ? "bg-sh-stripe" : ""
                      }`}
                    >
                      <td className="px-4 py-3 text-sh-black font-medium">
                        {ix.staffMember.displayName}
                      </td>
                      <td className="px-4 py-3 text-sh-black">
                        {ix.customer ? (
                          customerName
                        ) : (
                          <span className="text-sh-gray italic">Walk-in</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sh-gray">{ix.storeLocation}</td>
                      <td className="px-4 py-3">
                        <span className={`text-xs px-2 py-0.5 rounded ${sourceCfg.bg}`}>
                          {sourceCfg.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sh-gray text-xs">
                        {relativeTime(ix.startedAt)}
                      </td>
                      <td className="px-4 py-3">
                        {outcomeCfg ? (
                          <span className={`text-xs px-2 py-0.5 rounded ${outcomeCfg.bg}`}>
                            {outcomeCfg.label}
                          </span>
                        ) : (
                          <span className="text-xs text-sh-gray italic">
                            {ix.isActive ? "In progress" : "--"}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sh-gray text-xs max-w-[200px] truncate">
                        {ix.notes || "--"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-sh-gray/10">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="text-sm text-sh-blue hover:underline disabled:text-sh-gray disabled:no-underline min-h-[44px] px-3"
              >
                Previous
              </button>
              <span className="text-xs text-sh-gray">
                Page {page} of {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="text-sm text-sh-blue hover:underline disabled:text-sh-gray disabled:no-underline min-h-[44px] px-3"
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
