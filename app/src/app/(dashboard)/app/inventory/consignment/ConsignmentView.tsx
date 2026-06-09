"use client";

// /app/src/app/(dashboard)/app/inventory/consignment/ConsignmentView.tsx
//
// Consignment Inventory list body: status filter, search, paginated table.
// App Router port of the legacy inventory/consignment/index body (minus the
// MainLayout chrome, which the (dashboard) layout supplies). Reads the shared
// /api/consignment/items REST endpoint; currency uses the tenant formatter.

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import axios from "axios";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";

interface ConsignmentItem {
  id: string;
  barcode: string;
  quality: string;
  size: string;
  cost: number;
  retailPrice: number;
  status: string;
  storeLocation?: { name: string } | null;
}

interface PageResponse {
  items: ConsignmentItem[];
  total: number;
  page: number;
  pageSize: number;
}

const STATUS_OPTIONS = [
  { value: "", label: "All" },
  { value: "ON_FLOOR", label: "On Floor" },
  { value: "ON_APPROVAL", label: "On Approval" },
  { value: "SOLD", label: "Sold" },
  { value: "RETURNED_VENDOR", label: "Returned" },
  { value: "MISSING", label: "Missing" },
  { value: "PAID", label: "Paid" },
];

const STATUS_BADGE: Record<string, string> = {
  ON_FLOOR: "bg-green-100 text-green-800",
  ON_APPROVAL: "bg-amber-100 text-amber-800",
  SOLD: "bg-blue-100 text-blue-800",
  RETURNED_VENDOR: "bg-gray-100 text-gray-600",
  MISSING: "bg-red-100 text-red-800",
  PAID: "bg-sh-gold/20 text-sh-gold",
};

function statusLabel(status: string): string {
  const found = STATUS_OPTIONS.find((s) => s.value === status);
  return found ? found.label : status;
}

function badgeClass(status: string): string {
  return STATUS_BADGE[status] || "bg-gray-100 text-gray-600";
}

export function ConsignmentView() {
  const router = useRouter();
  const fmt = useMoneyFormatter();

  const [items, setItems] = useState<ConsignmentItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(50);
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);

  const fetchItems = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string | number> = { page, pageSize };
      if (status) params.status = status;
      if (search) params.search = search;
      const res = await axios.get<PageResponse>("/api/consignment/items", { params });
      setItems(res.data.items);
      setTotal(res.data.total);
    } catch {
      toast.error("Failed to load consignment items.");
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, status, search]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  useEffect(() => {
    setPage(1);
  }, [status, search]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="py-2 space-y-4 font-serif">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-sh-blue">Consignment Inventory</h1>
        <div className="flex gap-2">
          <Link href="/app/inventory/consignment/count">
            <Button variant="outline" className="min-h-[44px]">
              Count Rugs
            </Button>
          </Link>
          <Link href="/app/inventory/consignment/return">
            <Button variant="outline" className="min-h-[44px]">
              Return to Vendor
            </Button>
          </Link>
          <Link href="/app/inventory/consignment/returns-history">
            <Button variant="outline" className="min-h-[44px]">
              Returns History
            </Button>
          </Link>
          <Link href="/app/inventory/consignment/reconciliation">
            <Button variant="outline" className="min-h-[44px]">
              Reconciliation
            </Button>
          </Link>
          <Link href="/app/inventory/consignment/po-management">
            <Button variant="outline" className="min-h-[44px]">
              PO Management
            </Button>
          </Link>
          <Link href="/app/inventory/consignment/receive">
            <Button className="min-h-[44px]">Receive Shipment</Button>
          </Link>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 items-end">
        <div>
          <label htmlFor="consignment-status" className="block text-xs text-sh-gray mb-1">
            Status
          </label>
          <select
            id="consignment-status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="border border-sh-gray/40 rounded-lg px-3 min-h-[44px] text-sh-black font-serif"
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex-grow">
          <label htmlFor="consignment-search" className="block text-xs text-sh-gray mb-1">
            Search
          </label>
          <input
            id="consignment-search"
            type="text"
            placeholder="Barcode or quality..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="border border-sh-gray/40 rounded-lg px-3 min-h-[44px] w-full text-sh-black font-serif"
          />
        </div>
      </div>

      <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-sh-gray/20 bg-sh-linen">
                <th className="text-left px-4 py-3 text-sh-gray font-semibold">Barcode</th>
                <th className="text-left px-4 py-3 text-sh-gray font-semibold">Quality</th>
                <th className="text-left px-4 py-3 text-sh-gray font-semibold">Size</th>
                <th className="text-right px-4 py-3 text-sh-gray font-semibold">Cost</th>
                <th className="text-right px-4 py-3 text-sh-gray font-semibold">Retail</th>
                <th className="text-left px-4 py-3 text-sh-gray font-semibold">Status</th>
                <th className="text-left px-4 py-3 text-sh-gray font-semibold">Location</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-sh-gray">
                    Loading...
                  </td>
                </tr>
              )}
              {!loading && items.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-sh-gray">
                    No consignment items found.
                  </td>
                </tr>
              )}
              {!loading &&
                items.map((item, i) => (
                  <tr
                    key={item.id}
                    onClick={() => router.push(`/app/inventory/consignment/${item.id}`)}
                    className={`border-b border-sh-gray/10 cursor-pointer hover:bg-sh-linen transition ${
                      i % 2 === 1 ? "bg-sh-stripe" : ""
                    }`}
                  >
                    <td className="px-4 py-3 text-sh-black">{item.barcode}</td>
                    <td className="px-4 py-3 text-sh-black">{item.quality}</td>
                    <td className="px-4 py-3 text-sh-black">{item.size}</td>
                    <td className="px-4 py-3 text-sh-black text-right">{fmt(item.cost)}</td>
                    <td className="px-4 py-3 text-sh-black text-right">{fmt(item.retailPrice)}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${badgeClass(
                          item.status,
                        )}`}
                      >
                        {statusLabel(item.status)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sh-black">{item.storeLocation?.name || "-"}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex items-center justify-between text-sm text-sh-gray">
        <span>
          {total} item{total !== 1 ? "s" : ""}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
            className="min-h-[44px]"
          >
            Previous
          </Button>
          <span>
            Page {page} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
            className="min-h-[44px]"
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
