"use client";

// /app/src/app/(dashboard)/app/sales/returns/ReturnsListView.tsx
//
// Returns list body. App Router port of the legacy sales/returns/index body
// (minus MainLayout chrome, which the (dashboard) layout supplies). Reads the
// shared /api/returns REST endpoint; tab filter + search + pagination preserved.

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import axios from "axios";
import { toast } from "react-toastify";
import { format } from "date-fns";
import { Plus, Search, ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";

interface ReturnRow {
  id: number;
  returnNumber: string;
  status: string;
  quantity: number;
  createdAt: string;
  order: {
    id: number;
    orderno: string;
  };
  customer: {
    firstName: string;
    lastName: string;
  } | null;
  product: {
    name: string;
  } | null;
}

type TabFilter = "active" | "completed" | "all";

const STATUS_LABELS: Record<string, string> = {
  INITIATED: "Initiated",
  PICKUP_SCHEDULED: "Pickup Scheduled",
  PICKUP_COMPLETED: "Pickup Completed",
  RECEIVED: "Received",
  INSPECTED: "Inspected",
  RESTOCKED: "Restocked",
  WRITTEN_OFF: "Written Off",
  CLOSED: "Closed",
  CANCELLED: "Cancelled",
};

const STATUS_COLORS: Record<string, string> = {
  INITIATED: "bg-sh-gray/20 text-sh-gray",
  PICKUP_SCHEDULED: "bg-blue-100 text-blue-800",
  PICKUP_COMPLETED: "bg-blue-100 text-blue-800",
  RECEIVED: "bg-yellow-100 text-yellow-800",
  INSPECTED: "bg-orange-100 text-orange-800",
  RESTOCKED: "bg-green-100 text-green-800",
  WRITTEN_OFF: "bg-red-100 text-red-800",
  CLOSED: "bg-sh-gray/20 text-sh-gray",
  CANCELLED: "bg-red-100 text-red-800",
};

const ITEMS_PER_PAGE = 10;

export function ReturnsListView() {
  const router = useRouter();
  const [returns, setReturns] = useState<ReturnRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [tab, setTab] = useState<TabFilter>("active");
  const [loading, setLoading] = useState(true);

  const fetchReturns = useCallback(async () => {
    setLoading(true);
    try {
      const res = await axios.get("/api/returns", {
        params: { page, search, filter: tab, limit: ITEMS_PER_PAGE },
      });
      setReturns(res.data.returns || []);
      setTotal(res.data.total || 0);
    } catch {
      toast.error("Failed to load returns.");
    } finally {
      setLoading(false);
    }
  }, [page, search, tab]);

  useEffect(() => {
    fetchReturns();
  }, [fetchReturns]);

  const handleSearch = () => {
    setPage(1);
    setSearch(searchInput);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSearch();
  };

  const handleTabChange = (newTab: TabFilter) => {
    setTab(newTab);
    setPage(1);
  };

  const totalPages = Math.max(1, Math.ceil(total / ITEMS_PER_PAGE));

  return (
    <div className="font-serif">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-sh-blue">Returns</h1>
        <Link href="/app/sales/returns/new">
          <Button size="sm">
            <Plus className="w-4 h-4 mr-1.5" />
            New Return
          </Button>
        </Link>
      </div>

      {/* Tab Filters */}
      <div className="flex gap-2 mb-4">
        {(["active", "completed", "all"] as const).map((t) => (
          <button
            key={t}
            onClick={() => handleTabChange(t)}
            className={`px-3 py-1.5 text-sm rounded-full border transition ${
              tab === t
                ? "bg-sh-blue text-white border-sh-blue"
                : "bg-white text-sh-gray border-sh-gray/30 hover:border-sh-blue"
            }`}
          >
            {t === "active" ? "Active" : t === "completed" ? "Completed" : "All"}
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="flex gap-2 mb-4">
        <div className="relative flex-1">
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search by return #, order #, or customer name..."
            className="w-full border border-sh-gray/30 rounded-lg px-3 py-2 text-sm pr-10"
          />
          <button
            onClick={handleSearch}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-sh-gray hover:text-sh-blue transition"
          >
            <Search className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg shadow-md overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-sh-linen text-sh-black">
              <tr>
                <th className="p-3 border-b font-semibold">Return #</th>
                <th className="p-3 border-b font-semibold">Order #</th>
                <th className="p-3 border-b font-semibold">Customer</th>
                <th className="p-3 border-b font-semibold">Product</th>
                <th className="p-3 border-b font-semibold text-right">Qty</th>
                <th className="p-3 border-b font-semibold text-center">Status</th>
                <th className="p-3 border-b font-semibold">Date</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-sh-gray">
                    Loading...
                  </td>
                </tr>
              ) : returns.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-sh-gray">
                    No returns found.
                  </td>
                </tr>
              ) : (
                returns.map((r) => (
                  <tr
                    key={r.id}
                    onClick={() => router.push(`/app/sales/returns/${r.id}`)}
                    className="odd:bg-white even:bg-sh-stripe hover:bg-sh-gold/5 cursor-pointer transition"
                  >
                    <td className="p-3 border-b font-medium text-sh-blue">{r.returnNumber}</td>
                    <td className="p-3 border-b">{r.order?.orderno || "-"}</td>
                    <td className="p-3 border-b">
                      {r.customer ? `${r.customer.firstName} ${r.customer.lastName}` : "-"}
                    </td>
                    <td className="p-3 border-b">{r.product?.name || "-"}</td>
                    <td className="p-3 border-b text-right">{r.quantity}</td>
                    <td className="p-3 border-b text-center">
                      <span
                        className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[r.status] || "bg-gray-100 text-gray-800"}`}
                      >
                        {STATUS_LABELS[r.status] || r.status}
                      </span>
                    </td>
                    <td className="p-3 border-b">
                      {r.createdAt ? format(new Date(r.createdAt), "MM/dd/yyyy") : "-"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {total > ITEMS_PER_PAGE && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-sh-gray/10">
            <p className="text-xs text-sh-gray">
              Showing {(page - 1) * ITEMS_PER_PAGE + 1}
              {" - "}
              {Math.min(page * ITEMS_PER_PAGE, total)} of {total}
            </p>
            <div className="flex gap-1">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="p-1.5 rounded border border-sh-gray/30 text-sh-gray hover:text-sh-blue disabled:opacity-40 transition"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="px-3 py-1 text-sm text-sh-gray">
                {page} / {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="p-1.5 rounded border border-sh-gray/30 text-sh-gray hover:text-sh-blue disabled:opacity-40 transition"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
