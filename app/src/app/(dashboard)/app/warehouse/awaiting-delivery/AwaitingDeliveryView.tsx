"use client";

// /app/src/app/(dashboard)/app/warehouse/awaiting-delivery/AwaitingDeliveryView.tsx
//
// Awaiting delivery body (age + balance filter cards, expandable order rows with
// line-item drill-down). App Router port of the legacy
// pages/warehouse/awaiting-delivery.tsx body (minus MainLayout chrome, which
// comes from the (dashboard) layout). Reads the shared
// /api/warehouse/awaiting-delivery REST endpoint; the AwaitingDeliveryOrder
// response type is imported from that (untouched) API route.

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import axios from "axios";
import { ChevronDown, Loader2 } from "lucide-react";
import type { AwaitingDeliveryOrder } from "@/pages/api/warehouse/awaiting-delivery";

type AgeFilter = "all" | "thisMonth" | "oneToThree" | "threeToSix" | "sixToTwelve" | "overYear";

function formatDate(s: string | null) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function AgeBadge({ days }: { days: number }) {
  if (days > 365)
    return (
      <span className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700">
        {Math.floor(days / 30)}mo
      </span>
    );
  if (days > 90)
    return (
      <span className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700">
        {Math.floor(days / 30)}mo
      </span>
    );
  if (days > 30)
    return (
      <span className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-700">
        {days}d
      </span>
    );
  return (
    <span className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-700">
      {days}d
    </span>
  );
}

export function AwaitingDeliveryView() {
  const [orders, setOrders] = useState<AwaitingDeliveryOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<AgeFilter>("all");
  const [balanceFilter, setBalanceFilter] = useState<"all" | "unpaid" | "paid">("all");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [summary, setSummary] = useState({
    thisMonth: 0,
    oneToThree: 0,
    threeToSix: 0,
    sixToTwelve: 0,
    overYear: 0,
  });

  useEffect(() => {
    axios
      .get<{
        items: AwaitingDeliveryOrder[];
        total: number;
        summary: typeof summary;
      }>("/api/warehouse/awaiting-delivery")
      .then((r) => {
        setOrders(r.data.items);
        setSummary(r.data.summary);
      })
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    let result = orders;
    if (filter !== "all") {
      result = result.filter((o) => {
        if (filter === "thisMonth") return o.ageInDays <= 30;
        if (filter === "oneToThree") return o.ageInDays > 30 && o.ageInDays <= 90;
        if (filter === "threeToSix") return o.ageInDays > 90 && o.ageInDays <= 180;
        if (filter === "sixToTwelve") return o.ageInDays > 180 && o.ageInDays <= 365;
        if (filter === "overYear") return o.ageInDays > 365;
        return true;
      });
    }
    if (balanceFilter === "paid") result = result.filter((o) => o.balanceDue <= 0);
    if (balanceFilter === "unpaid") result = result.filter((o) => o.balanceDue > 0);
    return result;
  }, [orders, filter, balanceFilter]);

  const total = orders.length;

  const cards: { key: AgeFilter; label: string; count: number; warn?: boolean }[] = [
    { key: "all", label: "Total", count: total },
    { key: "thisMonth", label: "Last 30 Days", count: summary.thisMonth },
    { key: "oneToThree", label: "1-3 Months", count: summary.oneToThree },
    { key: "threeToSix", label: "3-6 Months", count: summary.threeToSix, warn: true },
    { key: "sixToTwelve", label: "6-12 Months", count: summary.sixToTwelve, warn: true },
    { key: "overYear", label: "Over 1 Year", count: summary.overYear, warn: true },
  ];

  return (
    <div className="py-2 space-y-5 font-serif">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Link href="/app/warehouse" className="text-sh-blue hover:underline text-sm">
            Warehouse
          </Link>
          <span className="text-sh-gray">/</span>
          <h1 className="text-2xl font-semibold text-sh-blue">Awaiting Delivery</h1>
          {(filter !== "all" || balanceFilter !== "all") && (
            <span className="text-sm text-sh-gray">({filtered.length})</span>
          )}
        </div>
        <div className="flex gap-2">
          <div className="flex rounded-lg border border-sh-gray/30 overflow-hidden">
            {(["all", "unpaid", "paid"] as const).map((bf) => (
              <button
                key={bf}
                onClick={() => setBalanceFilter(bf)}
                className={`px-3 py-2 text-xs font-semibold min-h-[44px] transition ${
                  balanceFilter === bf
                    ? "bg-sh-navy text-white"
                    : "bg-white text-sh-navy hover:bg-sh-linen"
                }`}
              >
                {bf === "all" ? "All" : bf === "unpaid" ? "Balance Due" : "Paid"}
              </button>
            ))}
          </div>
          {(filter !== "all" || balanceFilter !== "all") && (
            <button
              onClick={() => {
                setFilter("all");
                setBalanceFilter("all");
              }}
              className="px-4 py-2 text-sm font-semibold border border-sh-navy text-sh-navy rounded-lg hover:bg-sh-linen transition min-h-[44px]"
            >
              Clear
            </button>
          )}
          <Link href="/app/warehouse/outbound">
            <span className="px-4 py-2 text-sm font-semibold border border-sh-navy text-sh-navy rounded-lg hover:bg-sh-linen transition min-h-[44px] flex items-center cursor-pointer">
              Outbound
            </span>
          </Link>
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-sh-blue mr-3" />
          <span className="text-sh-gray">Loading orders...</span>
        </div>
      )}

      {!loading && (
        <>
          <p className="text-sm text-sh-gray">
            Orders with status ORDER and no invoice. These have not been delivered or fulfilled. Old
            orders may need to be researched and closed out.
          </p>

          <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
            {cards.map((c) => (
              <button
                key={c.key}
                onClick={() => setFilter(c.key)}
                className={`bg-white rounded-xl border p-3 text-center transition min-h-[44px] ${
                  filter === c.key
                    ? "border-sh-blue ring-2 ring-sh-blue/20"
                    : c.warn && c.count > 0
                      ? "border-red-200 hover:border-red-400"
                      : "border-sh-gray/15 hover:border-sh-blue/30"
                }`}
              >
                <div className="text-xs text-sh-gray mb-1">{c.label}</div>
                <div
                  className={`text-xl font-semibold ${c.warn && c.count > 0 ? "text-red-600" : "text-sh-black"}`}
                >
                  {c.count}
                </div>
              </button>
            ))}
          </div>

          <div className="bg-white rounded-xl border border-sh-gray/15 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-sh-gray/20 bg-sh-linen">
                  <th className="text-left px-4 py-3 text-sh-gray font-semibold">Order #</th>
                  <th className="text-left px-4 py-3 text-sh-gray font-semibold">Customer</th>
                  <th className="text-left px-4 py-3 text-sh-gray font-semibold">Store</th>
                  <th className="text-left px-4 py-3 text-sh-gray font-semibold">Order Date</th>
                  <th className="text-right px-4 py-3 text-sh-gray font-semibold">Items</th>
                  <th className="text-right px-4 py-3 text-sh-gray font-semibold">Balance Due</th>
                  <th className="text-left px-4 py-3 text-sh-gray font-semibold">Inbound</th>
                  <th className="text-left px-4 py-3 text-sh-gray font-semibold">Age</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-sh-gray">
                      {filter === "all"
                        ? "No orders awaiting delivery."
                        : "No orders in this age range."}
                    </td>
                  </tr>
                )}
                {filtered.slice(0, 200).map((order, i) => {
                  const isExpanded = expandedId === order.id;
                  return (
                    <>
                      <tr
                        key={order.id}
                        onClick={() => setExpandedId(isExpanded ? null : order.id)}
                        className={`border-b border-sh-gray/10 cursor-pointer hover:bg-sh-linen/50 transition ${i % 2 === 1 && !isExpanded ? "bg-sh-stripe" : ""}`}
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5">
                            <ChevronDown
                              className={`w-3.5 h-3.5 text-sh-gray transition-transform ${isExpanded ? "rotate-180" : ""}`}
                            />
                            <Link
                              href={`/app/sales/orders/${order.id}`}
                              onClick={(e) => e.stopPropagation()}
                              className="text-sh-blue hover:underline font-mono text-xs min-h-[44px] flex items-center"
                            >
                              {order.orderno}
                            </Link>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sh-black text-xs">{order.customerName}</td>
                        <td className="px-4 py-3 text-sh-gray text-xs">{order.storeName || "—"}</td>
                        <td className="px-4 py-3 text-sh-black text-xs">
                          {formatDate(order.orderDate)}
                        </td>
                        <td className="px-4 py-3 text-right text-sh-black">
                          {order.lineItemCount}
                        </td>
                        <td
                          className={`px-4 py-3 text-right text-xs font-semibold ${order.balanceDue > 0 ? "text-red-600" : "text-green-600"}`}
                        >
                          {order.balanceDue > 0
                            ? `$${order.balanceDue.toLocaleString("en-US", { minimumFractionDigits: 2 })}`
                            : order.balanceDue === 0
                              ? "Paid"
                              : `($${Math.abs(order.balanceDue).toLocaleString("en-US", { minimumFractionDigits: 2 })})`}
                        </td>
                        <td className="px-4 py-3">
                          {order.linkedPOs.length === 0 ? (
                            <span className="text-xs text-sh-gray">No PO</span>
                          ) : (
                            <div className="space-y-0.5">
                              {order.linkedPOs.map((po) => (
                                <div key={po.id} className="flex items-center gap-1.5">
                                  <Link
                                    href={`/app/purchasing/orders/${po.id}`}
                                    onClick={(e) => e.stopPropagation()}
                                    className="text-sh-blue hover:underline font-mono text-xs"
                                  >
                                    {po.poNumber}
                                  </Link>
                                  <span
                                    className={`inline-block px-1.5 py-0.5 rounded text-xs font-semibold ${
                                      po.status === "RECEIVED_FULL"
                                        ? "bg-green-100 text-green-700"
                                        : po.status === "RECEIVED_PARTIAL"
                                          ? "bg-amber-100 text-amber-700"
                                          : "bg-sh-blue/10 text-sh-blue"
                                    }`}
                                  >
                                    {po.status === "RECEIVED_FULL"
                                      ? "Received"
                                      : po.status === "RECEIVED_PARTIAL"
                                        ? "Partial"
                                        : "Pending"}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <AgeBadge days={order.ageInDays} />
                        </td>
                      </tr>
                      {isExpanded && order.lineItems.length > 0 && (
                        <tr key={`${order.id}-detail`}>
                          <td colSpan={8} className="bg-sh-linen/60 px-6 py-3">
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="text-sh-gray">
                                  <th className="text-left py-1 font-medium">Product</th>
                                  <th className="text-left py-1 font-medium">Part #</th>
                                  <th className="text-right py-1 font-medium">Qty</th>
                                  <th className="text-right py-1 font-medium">Price</th>
                                  <th className="text-left py-1 font-medium pl-3">Status</th>
                                </tr>
                              </thead>
                              <tbody>
                                {order.lineItems.map((li) => (
                                  <tr key={li.id} className="border-t border-sh-gray/10">
                                    <td className="py-1.5 text-sh-black">
                                      {li.productName || "—"}
                                    </td>
                                    <td className="py-1.5 text-sh-gray font-mono">
                                      {li.partNo || "—"}
                                    </td>
                                    <td className="py-1.5 text-right text-sh-black">
                                      {li.orderedQuantity}
                                    </td>
                                    <td className="py-1.5 text-right text-sh-black">
                                      {li.netPrice > 0
                                        ? `$${li.netPrice.toLocaleString("en-US", { minimumFractionDigits: 2 })}`
                                        : "—"}
                                    </td>
                                    <td className="py-1.5 pl-3">
                                      {li.lineItemStatus && (
                                        <span className="px-1.5 py-0.5 rounded bg-sh-gray/10 text-sh-gray font-medium">
                                          {li.lineItemStatus}
                                        </span>
                                      )}
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
                })}
                {filtered.length > 200 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-3 text-center text-sh-gray text-xs">
                      Showing first 200 of {filtered.length} orders
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
