"use client";

// /app/src/app/(dashboard)/app/inventory/consignment/credits-owed/CreditsOwedView.tsx
//
// Credits Owed body: rugs paid to the vendor then returned by the customer,
// whose cost must be recouped via a negative PO line. App Router port of the
// legacy inventory/consignment/credits-owed body (minus MainLayout chrome).
// Reads the shared /api/consignment/credits-owed REST endpoint; money uses the
// tenant formatter. The CreditOwedItem type is still owned by the REST handler.

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import axios from "axios";
import { toast } from "react-toastify";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import type { CreditOwedItem } from "@/pages/api/consignment/credits-owed";

function formatDate(s: string | null): string {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

const STATUS_BADGE: Record<string, string> = {
  PAID: "bg-green-100 text-green-700",
  ON_FLOOR: "bg-sh-blue/10 text-sh-blue",
  SOLD: "bg-amber-100 text-amber-700",
};

function StatusBadge({ status }: Readonly<{ status: string }>) {
  const cls = STATUS_BADGE[status] || "bg-gray-100 text-sh-gray";
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${cls}`}>
      {status.replace("_", " ")}
    </span>
  );
}

export function CreditsOwedView() {
  const fmt = useMoneyFormatter();

  const [items, setItems] = useState<CreditOwedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [totalCredit, setTotalCredit] = useState(0);

  const loadCredits = useCallback(async () => {
    setLoading(true);
    try {
      const res = await axios.get<{ items: CreditOwedItem[]; total: number; totalCredit: number }>(
        "/api/consignment/credits-owed",
      );
      setItems(res.data.items);
      setTotalCredit(res.data.totalCredit);
    } catch {
      toast.error("Failed to load credits owed.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCredits();
  }, [loadCredits]);

  return (
    <div className="py-2 space-y-5 font-serif">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Link
            href="/app/inventory/consignment/payments"
            className="text-sh-blue hover:underline text-sm"
          >
            Payments
          </Link>
          <span className="text-sh-gray">/</span>
          <h1 className="text-2xl font-semibold text-sh-blue">Credits Owed</h1>
        </div>
        <div className="flex gap-2">
          <Link href="/app/inventory/consignment/unpaid-sales">
            <span className="px-4 py-2 text-sm font-semibold border border-sh-navy text-sh-navy rounded-lg hover:bg-sh-linen transition min-h-[44px] flex items-center cursor-pointer">
              Unpaid Sales
            </span>
          </Link>
          <Link href="/app/inventory/consignment/po-management">
            <span className="px-4 py-2 text-sm font-semibold border border-sh-navy text-sh-navy rounded-lg hover:bg-sh-linen transition min-h-[44px] flex items-center cursor-pointer">
              PO Management
            </span>
          </Link>
        </div>
      </div>

      {!loading && (
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-white rounded-xl border border-sh-gray/15 p-4 text-center">
            <div className="text-xs text-sh-gray mb-1">Items with Credit Owed</div>
            <div className="text-2xl font-semibold text-sh-black">{items.length}</div>
          </div>
          <div className="bg-white rounded-xl border border-sh-gray/15 p-4 text-center">
            <div className="text-xs text-sh-gray mb-1">Total Credit to Recoup</div>
            <div className="text-2xl font-semibold text-red-600">{fmt(totalCredit)}</div>
          </div>
        </div>
      )}

      <p className="text-sm text-sh-gray">
        These rugs were paid to the vendor but later returned by the customer. Apply a negative line
        on the next PO to recoup the cost.
      </p>

      <div className="bg-white rounded-xl border border-sh-gray/15 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-sh-gray/20 bg-sh-linen">
              <th className="text-left px-4 py-3 text-sh-gray font-semibold">Barcode</th>
              <th className="text-left px-4 py-3 text-sh-gray font-semibold">Quality / Size</th>
              <th className="text-left px-4 py-3 text-sh-gray font-semibold">Customer</th>
              <th className="text-left px-4 py-3 text-sh-gray font-semibold">Paid Date</th>
              <th className="text-left px-4 py-3 text-sh-gray font-semibold">Status</th>
              <th className="text-right px-4 py-3 text-sh-gray font-semibold">Credit Amount</th>
              <th className="text-left px-4 py-3 text-sh-gray font-semibold">Order</th>
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
                  No credits owed — all clear.
                </td>
              </tr>
            )}
            {items.map((item, i) => (
              <tr
                key={item.id}
                className={`border-b border-sh-gray/10 ${i % 2 === 1 ? "bg-sh-stripe" : ""}`}
              >
                <td className="px-4 py-3 font-mono text-sh-black text-xs">{item.barcode}</td>
                <td className="px-4 py-3 text-sh-black">
                  {item.quality || "—"}
                  {item.size ? ` / ${item.size}` : ""}
                </td>
                <td className="px-4 py-3 text-sh-gray">{item.customerName || "—"}</td>
                <td className="px-4 py-3 text-sh-black">{formatDate(item.paidDate)}</td>
                <td className="px-4 py-3">
                  <StatusBadge status={item.status} />
                </td>
                <td className="px-4 py-3 text-right text-red-600 font-semibold">
                  {fmt(item.cost)}
                </td>
                <td className="px-4 py-3">
                  {item.salesOrderId ? (
                    <Link
                      href={`/app/sales/orders/${item.salesOrderId}`}
                      className="text-sh-blue hover:underline text-xs"
                    >
                      {item.orderNumber || `#${item.salesOrderId}`}
                    </Link>
                  ) : (
                    <span className="text-sh-gray text-xs">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
