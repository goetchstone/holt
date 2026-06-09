"use client";

// /app/src/app/(dashboard)/app/sales/proposals/ProposalsListView.tsx
//
// B2B Proposals list body. App Router port of the legacy sales/proposals/index
// body (minus MainLayout chrome, which the (dashboard) layout supplies). Reads
// the shared /api/proposals REST endpoint; search + status filter + pagination
// preserved.

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import axios from "axios";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { Plus, FileText } from "lucide-react";

interface ProposalRow {
  id: number;
  proposalNumber: string;
  status: string;
  projectName: string | null;
  companyName: string | null;
  customer: { firstName: string | null; lastName: string | null } | null;
  salesPerson: { displayName: string } | null;
  _count: { lineItems: number };
  created: string;
}

const STATUS_COLORS: Record<string, string> = {
  DRAFT: "bg-sh-gray/20 text-sh-gray",
  SENT: "bg-sh-blue/15 text-sh-blue",
  ACCEPTED: "bg-green-100 text-green-800",
  DECLINED: "bg-red-100 text-red-700",
  EXPIRED: "bg-amber-100 text-amber-700",
};

export function ProposalsListView() {
  const router = useRouter();
  const [proposals, setProposals] = useState<ProposalRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const limit = 20;

  const fetchData = useCallback(
    async (p: number) => {
      setLoading(true);
      try {
        const params: Record<string, string> = { page: String(p), limit: String(limit) };
        if (search) params.search = search;
        if (statusFilter) params.status = statusFilter;
        const { data } = await axios.get("/api/proposals", { params });
        setProposals(data.proposals);
        setTotal(data.total);
      } catch {
        toast.error("Failed to load proposals");
      } finally {
        setLoading(false);
      }
    },
    [search, statusFilter],
  );

  useEffect(() => {
    fetchData(1);
  }, [fetchData]);

  function handleSearch() {
    setPage(1);
    fetchData(1);
  }

  async function handleCreate() {
    setCreating(true);
    try {
      const { data } = await axios.post("/api/proposals", {});
      router.push(`/app/sales/proposals/${data.id}`);
    } catch {
      toast.error("Failed to create proposal");
      setCreating(false);
    }
  }

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="py-2 space-y-6 font-serif">
      <nav className="text-sm text-sh-gray">
        <Link href="/app/sales" className="hover:underline">
          Sales
        </Link>
        <span className="mx-2">/</span>
        <span className="text-sh-black">B2B Proposals</span>
      </nav>

      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-semibold text-sh-navy">B2B Proposals</h1>
        <Button onClick={handleCreate} disabled={creating} className="min-h-[44px]">
          <Plus className="w-4 h-4 mr-2" />
          {creating ? "Creating..." : "New Proposal"}
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            placeholder="Search proposals..."
            className="w-full border border-sh-gray/30 rounded-lg px-3 py-2 text-sm min-h-[44px]"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setPage(1);
            fetchData(1);
          }}
          className="border border-sh-gray/30 rounded-lg px-3 py-2 text-sm min-h-[44px]"
        >
          <option value="">All Statuses</option>
          <option value="DRAFT">Draft</option>
          <option value="SENT">Sent</option>
          <option value="ACCEPTED">Accepted</option>
          <option value="DECLINED">Declined</option>
          <option value="EXPIRED">Expired</option>
        </select>
        <Button variant="outline" onClick={handleSearch} className="min-h-[44px]">
          Search
        </Button>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-sh-gray/15 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-sh-gray/15 bg-sh-stripe">
              <th className="text-left px-4 py-3 font-medium text-sh-gray">Proposal</th>
              <th className="text-left px-4 py-3 font-medium text-sh-gray">Project</th>
              <th className="text-left px-4 py-3 font-medium text-sh-gray">Customer</th>
              <th className="text-left px-4 py-3 font-medium text-sh-gray">Status</th>
              <th className="text-right px-4 py-3 font-medium text-sh-gray">Items</th>
              <th className="text-left px-4 py-3 font-medium text-sh-gray">Created</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sh-gray">
                  Loading...
                </td>
              </tr>
            ) : proposals.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sh-gray">
                  <FileText className="w-8 h-8 mx-auto mb-2 text-sh-gray/30" />
                  No proposals found
                </td>
              </tr>
            ) : (
              proposals.map((p, idx) => {
                const customerName = p.customer
                  ? [p.customer.firstName, p.customer.lastName].filter(Boolean).join(" ")
                  : p.companyName || "—";
                return (
                  <tr
                    key={p.id}
                    className={`border-b border-sh-gray/10 cursor-pointer hover:bg-sh-linen transition ${idx % 2 === 1 ? "bg-sh-stripe" : ""}`}
                    onClick={() => router.push(`/app/sales/proposals/${p.id}`)}
                  >
                    <td className="px-4 py-3">
                      <span className="text-sh-blue font-medium">{p.proposalNumber}</span>
                    </td>
                    <td className="px-4 py-3 text-sh-black">{p.projectName || "—"}</td>
                    <td className="px-4 py-3 text-sh-black">{customerName}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[p.status] || "bg-sh-gray/20 text-sh-gray"}`}
                      >
                        {p.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-sh-gray">{p._count.lineItems}</td>
                    <td className="px-4 py-3 text-sh-gray text-xs">
                      {new Date(p.created).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <button
            onClick={() => {
              setPage(page - 1);
              fetchData(page - 1);
            }}
            disabled={page <= 1 || loading}
            className="px-3 py-2 text-sm border border-sh-gray/20 rounded-lg hover:bg-sh-linen disabled:opacity-30 min-h-[44px]"
          >
            Previous
          </button>
          <span className="text-sm text-sh-gray">
            Page {page} of {totalPages}
          </span>
          <button
            onClick={() => {
              setPage(page + 1);
              fetchData(page + 1);
            }}
            disabled={page >= totalPages || loading}
            className="px-3 py-2 text-sm border border-sh-gray/20 rounded-lg hover:bg-sh-linen disabled:opacity-30 min-h-[44px]"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
