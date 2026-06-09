"use client";

// /app/src/app/(dashboard)/app/inventory/consignment/returns-history/ReturnsHistoryView.tsx
//
// Vendor Returns History body: summary line plus an expandable table of grouped
// vendor-return shipments with per-item detail. App Router port of the legacy
// inventory/consignment/returns-history body (minus MainLayout chrome). Reads the
// shared /api/consignment/vendor-returns REST endpoint; money uses the tenant
// formatter.

import { useEffect, useState, useCallback } from "react";
import axios from "axios";
import Link from "next/link";
import { toast } from "react-toastify";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";

type MoneyFormatter = ReturnType<typeof useMoneyFormatter>;

interface ReturnItem {
  id: number;
  barcode: string;
  customerNumber: string | null;
  quality: string | null;
  size: string | null;
  cost: number;
  creditOwed: boolean;
}

interface VendorReturn {
  id: number;
  vendorName: string;
  returnDate: string;
  confirmedDate: string | null;
  status: string;
  notes: string | null;
  itemCount: number;
  totalCost: number;
  creditCount: number;
  items: ReturnItem[];
}

function formatDate(s: string | null): string {
  if (!s) return "";
  return new Date(s).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function statusBadgeClasses(status: string): string {
  return status === "CONFIRMED" ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800";
}

export function ReturnsHistoryView() {
  const fmt = useMoneyFormatter();

  const [returns, setReturns] = useState<VendorReturn[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const loadReturns = useCallback(async () => {
    setLoading(true);
    try {
      const res = await axios.get<{ returns: VendorReturn[] }>("/api/consignment/vendor-returns");
      setReturns(res.data.returns);
    } catch {
      toast.error("Failed to load vendor returns.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadReturns();
  }, [loadReturns]);

  function toggleExpand(id: number) {
    setExpandedId((prev) => (prev === id ? null : id));
  }

  const totalItems = returns.reduce((sum, r) => sum + r.itemCount, 0);
  const totalCost = returns.reduce((sum, r) => sum + r.totalCost, 0);
  const totalCredits = returns.reduce((sum, r) => sum + r.creditCount, 0);

  return (
    <div className="py-2 space-y-6 font-serif">
      <div className="flex items-center gap-3">
        <Link href="/app/inventory/consignment" className="text-sh-blue hover:underline text-sm">
          Consignment
        </Link>
        <span className="text-sh-gray">/</span>
        <h1 className="text-2xl font-semibold text-sh-blue">Returns to Vendor</h1>
      </div>

      {!loading && returns.length > 0 && (
        <div className="flex gap-6 text-sm">
          <div>
            <span className="text-sh-gray">Total Returns:</span>{" "}
            <span className="font-semibold text-sh-navy">{returns.length}</span>
          </div>
          <div>
            <span className="text-sh-gray">Items Returned:</span>{" "}
            <span className="font-semibold text-sh-navy">{totalItems}</span>
          </div>
          <div>
            <span className="text-sh-gray">Total Cost:</span>{" "}
            <span className="font-semibold text-sh-navy">{fmt(totalCost)}</span>
          </div>
          {totalCredits > 0 && (
            <div>
              <span className="text-sh-gray">Credits Owed:</span>{" "}
              <span className="font-semibold text-red-700">{totalCredits}</span>
            </div>
          )}
        </div>
      )}

      <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-sh-gray/20 bg-sh-linen">
              <th className="text-left px-4 py-3 text-sh-gray font-semibold">Return Date</th>
              <th className="text-left px-4 py-3 text-sh-gray font-semibold">Vendor</th>
              <th className="text-left px-4 py-3 text-sh-gray font-semibold">Status</th>
              <th className="text-right px-4 py-3 text-sh-gray font-semibold">Items</th>
              <th className="text-right px-4 py-3 text-sh-gray font-semibold">Total Cost</th>
              <th className="text-left px-4 py-3 text-sh-gray font-semibold">Notes</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sh-gray">
                  Loading...
                </td>
              </tr>
            )}
            {!loading && returns.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sh-gray">
                  No vendor returns recorded.
                </td>
              </tr>
            )}
            {returns.map((ret, i) => (
              <ReturnRow
                key={ret.id}
                ret={ret}
                striped={i % 2 === 1}
                expanded={expandedId === ret.id}
                onToggle={() => toggleExpand(ret.id)}
                fmt={fmt}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface ReturnRowProps {
  ret: VendorReturn;
  striped: boolean;
  expanded: boolean;
  onToggle: () => void;
  fmt: MoneyFormatter;
}

function ReturnRow({ ret, striped, expanded, onToggle, fmt }: Readonly<ReturnRowProps>) {
  return (
    <>
      <tr
        onClick={onToggle}
        className={`border-b border-sh-gray/10 cursor-pointer hover:bg-sh-linen transition ${
          striped ? "bg-sh-stripe" : ""
        }`}
      >
        <td className="px-4 py-3 text-sh-black">
          <span className="flex items-center gap-1.5">
            {expanded ? (
              <ChevronDown className="h-4 w-4 text-sh-gray" />
            ) : (
              <ChevronRight className="h-4 w-4 text-sh-gray" />
            )}
            {formatDate(ret.returnDate)}
          </span>
        </td>
        <td className="px-4 py-3 text-sh-black">{ret.vendorName}</td>
        <td className="px-4 py-3">
          <span
            className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${statusBadgeClasses(
              ret.status,
            )}`}
          >
            {ret.status}
          </span>
          {ret.creditCount > 0 && (
            <span className="ml-2 inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700">
              {ret.creditCount} credit{ret.creditCount !== 1 ? "s" : ""}
            </span>
          )}
        </td>
        <td className="px-4 py-3 text-right text-sh-black">{ret.itemCount}</td>
        <td className="px-4 py-3 text-right text-sh-black">{fmt(ret.totalCost)}</td>
        <td className="px-4 py-3 text-sh-gray text-xs truncate max-w-[200px]">{ret.notes || ""}</td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={6} className="bg-gray-50 px-8 py-4">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left py-1 text-sh-gray">Barcode</th>
                  <th className="text-left py-1 text-sh-gray">Cust #</th>
                  <th className="text-left py-1 text-sh-gray">Quality</th>
                  <th className="text-left py-1 text-sh-gray">Size</th>
                  <th className="text-right py-1 text-sh-gray">Cost</th>
                  <th className="text-left py-1 text-sh-gray">Credit</th>
                </tr>
              </thead>
              <tbody>
                {ret.items.map((item) => (
                  <tr key={item.id} className="border-b border-gray-100">
                    <td className="py-1">
                      <Link
                        href={`/app/inventory/consignment/${item.id}`}
                        className="text-sh-blue hover:underline"
                      >
                        {item.barcode}
                      </Link>
                    </td>
                    <td className="py-1 text-sh-gray">{item.customerNumber}</td>
                    <td className="py-1 text-sh-gray">{item.quality}</td>
                    <td className="py-1 text-sh-gray">{item.size}</td>
                    <td className="py-1 text-right">{fmt(item.cost)}</td>
                    <td className="py-1">
                      {item.creditOwed && <span className="text-red-600 font-semibold">Yes</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}
