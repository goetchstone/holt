"use client";

// /app/src/app/(dashboard)/app/inventory/consignment/unpaid-sales/UnpaidSalesView.tsx
//
// Unpaid Consignment Sales body: summary cards + a table of sold-but-unpaid
// consignment items with an age badge. App Router port of the legacy
// inventory/consignment/unpaid-sales body (minus MainLayout chrome). Reads the
// shared /api/consignment/unpaid-sales REST endpoint; money uses the tenant
// formatter.

import { useEffect, useState, useCallback } from "react";
import axios from "axios";
import Link from "next/link";
import { toast } from "react-toastify";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import type { UnpaidSaleItem } from "@/pages/api/consignment/unpaid-sales";

function formatDate(s: string | null): string {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function daysSince(s: string | null): number {
  if (!s) return 9999;
  return Math.floor((Date.now() - new Date(s).getTime()) / 86400000);
}

function ageBadgeClasses(days: number): string {
  if (days > 60) return "bg-red-100 text-red-700";
  if (days > 14) return "bg-amber-100 text-amber-700";
  return "bg-green-100 text-green-700";
}

function AgeBadge({ saleDate }: Readonly<{ saleDate: string | null }>) {
  const days = daysSince(saleDate);
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${ageBadgeClasses(days)}`}
    >
      {days}d ago
    </span>
  );
}

export function UnpaidSalesView() {
  const fmt = useMoneyFormatter();

  const [items, setItems] = useState<UnpaidSaleItem[]>([]);
  const [loading, setLoading] = useState(true);

  const loadItems = useCallback(async () => {
    setLoading(true);
    try {
      const res = await axios.get<{ items: UnpaidSaleItem[]; total: number }>(
        "/api/consignment/unpaid-sales",
      );
      setItems(res.data.items);
    } catch {
      toast.error("Failed to load unpaid sales.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  const total = items.reduce((s, i) => s + i.cost, 0);
  const overdue = items.filter((i) => daysSince(i.saleDate) > 14).length;

  return (
    <div className="py-2 space-y-5 font-serif">
      <div className="flex items-center gap-3">
        <Link
          href="/app/inventory/consignment/payments"
          className="text-sh-blue hover:underline text-sm"
        >
          Payments
        </Link>
        <span className="text-sh-gray">/</span>
        <h1 className="text-2xl font-semibold text-sh-blue">Unpaid Sales</h1>
      </div>

      {!loading && (
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-white rounded-xl border border-sh-gray/15 p-4 text-center">
            <div className="text-xs text-sh-gray mb-1">Total Unpaid</div>
            <div className="text-2xl font-semibold text-sh-black">{items.length}</div>
          </div>
          <div className="bg-white rounded-xl border border-sh-gray/15 p-4 text-center">
            <div className="text-xs text-sh-gray mb-1">Over 14 Days Old</div>
            <div
              className={`text-2xl font-semibold ${overdue > 0 ? "text-red-600" : "text-sh-black"}`}
            >
              {overdue}
            </div>
          </div>
          <div className="bg-white rounded-xl border border-sh-gray/15 p-4 text-center">
            <div className="text-xs text-sh-gray mb-1">Total Cost Owed</div>
            <div className="text-2xl font-semibold text-sh-black">{fmt(total)}</div>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border border-sh-gray/15 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-sh-gray/20 bg-sh-linen">
              <th className="text-left px-4 py-3 text-sh-gray font-semibold">Barcode</th>
              <th className="text-left px-4 py-3 text-sh-gray font-semibold">Quality / Size</th>
              <th className="text-left px-4 py-3 text-sh-gray font-semibold">Customer</th>
              <th className="text-left px-4 py-3 text-sh-gray font-semibold">Sale Date</th>
              <th className="text-left px-4 py-3 text-sh-gray font-semibold">Age</th>
              <th className="text-right px-4 py-3 text-sh-gray font-semibold">Cost</th>
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
                  No unpaid sales — all clear.
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
                <td className="px-4 py-3 text-sh-gray">{item.saleCustomerName || "—"}</td>
                <td className="px-4 py-3 text-sh-black">{formatDate(item.saleDate)}</td>
                <td className="px-4 py-3">
                  <AgeBadge saleDate={item.saleDate} />
                </td>
                <td className="px-4 py-3 text-right text-sh-black">{fmt(item.cost)}</td>
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
