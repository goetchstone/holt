"use client";

// /app/src/app/(dashboard)/app/warehouse/outbound/OutboundDashboardView.tsx
//
// Outbound dashboard body (summary cards, scheduled deliveries, needs-scheduling
// queue, stock transfers). App Router port of the legacy
// pages/warehouse/outbound.tsx body (minus MainLayout chrome, which comes from
// the (dashboard) layout). Reads the shared /api/warehouse/outbound-dashboard
// REST endpoint.

import { useState, useEffect } from "react";
import Link from "next/link";
import axios from "axios";
import { Loader2 } from "lucide-react";
import { format } from "date-fns";

interface DeliveryItem {
  id: number;
  scheduledDate: string | null;
  scheduledTime: string | null;
  status: string;
  customerName: string;
  orderNumber: string;
  salesOrderId: number;
  zoneName: string | null;
}

interface NeedsSchedulingItem {
  id: number;
  orderno: string;
  customerName: string;
  orderDate: string | null;
  lineItemCount: number;
  daysSinceReceived: number;
}

interface TransferItem {
  id: number;
  fromLocation: string;
  toLocation: string;
  itemCount: number;
  status: string;
  shippedAt: string | null;
}

interface DashboardData {
  summary: {
    upcomingDeliveries: number;
    needsScheduling: number;
    activeTransfers: number;
  };
  deliveries: DeliveryItem[];
  needsScheduling: NeedsSchedulingItem[];
  transfers: TransferItem[];
}

const STATUS_STYLES: Record<string, string> = {
  CONFIRMED: "bg-green-100 text-green-800",
  SCHEDULED: "bg-blue-100 text-blue-800",
  PENDING: "bg-sh-gray/20 text-sh-gray",
  IN_PROGRESS: "bg-yellow-100 text-yellow-800",
  DRAFT: "bg-sh-gray/20 text-sh-gray",
  IN_TRANSIT: "bg-blue-100 text-blue-800",
};

const STATUS_LABELS: Record<string, string> = {
  CONFIRMED: "Confirmed",
  SCHEDULED: "Scheduled",
  PENDING: "Pending",
  IN_PROGRESS: "In Progress",
  DRAFT: "Draft",
  IN_TRANSIT: "In Transit",
};

function daysWaitingStyle(days: number): string {
  if (days > 7) return "bg-red-100 text-red-800";
  if (days >= 3) return "bg-yellow-100 text-yellow-800";
  return "bg-green-100 text-green-800";
}

export function OutboundDashboardView() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await axios.get("/api/warehouse/outbound-dashboard");
        setData(res.data);
      } catch {
        // Silent fail -- dashboard shows empty state
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  if (loading) {
    return (
      <div className="py-2 font-serif">
        <h1 className="text-2xl text-sh-blue font-semibold mb-6">Outbound</h1>
        <div className="flex items-center gap-2 text-sh-gray">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>Loading...</span>
        </div>
      </div>
    );
  }

  const summary = data?.summary || {
    upcomingDeliveries: 0,
    needsScheduling: 0,
    activeTransfers: 0,
  };
  const deliveries = data?.deliveries || [];
  const needsScheduling = data?.needsScheduling || [];
  const transfers = data?.transfers || [];

  return (
    <div className="py-2 space-y-8 font-serif">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-sh-gray">
        <Link href="/app/warehouse" className="hover:text-sh-blue transition">
          Warehouse
        </Link>
        <span>/</span>
        <span className="text-sh-black">Outbound</span>
      </div>

      <h1 className="text-2xl text-sh-blue font-semibold">Outbound</h1>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-5">
          <p className="text-sm text-sh-gray">Upcoming Deliveries</p>
          <p className="text-2xl font-semibold text-sh-black">{summary.upcomingDeliveries}</p>
        </div>
        <div
          className={`rounded-lg border shadow-md p-5 ${
            summary.needsScheduling > 0
              ? "bg-yellow-50 border-yellow-300"
              : "bg-white border-sh-gray/20"
          }`}
        >
          <p
            className={`text-sm ${summary.needsScheduling > 0 ? "text-yellow-800" : "text-sh-gray"}`}
          >
            Needs Scheduling
          </p>
          <p
            className={`text-2xl font-semibold ${summary.needsScheduling > 0 ? "text-yellow-800" : "text-sh-black"}`}
          >
            {summary.needsScheduling}
          </p>
        </div>
        <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-5">
          <p className="text-sm text-sh-gray">Active Transfers</p>
          <p className="text-2xl font-semibold text-sh-black">{summary.activeTransfers}</p>
        </div>
      </div>

      {/* Scheduled Deliveries */}
      <div>
        <h2 className="text-lg text-sh-black font-semibold mb-3">Scheduled Deliveries</h2>
        <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-sh-gray/20 bg-sh-stripe">
                <th className="text-left px-4 py-3 font-medium text-sh-gray">Date</th>
                <th className="text-left px-4 py-3 font-medium text-sh-gray">Time</th>
                <th className="text-left px-4 py-3 font-medium text-sh-gray">Customer</th>
                <th className="text-left px-4 py-3 font-medium text-sh-gray">Order #</th>
                <th className="text-left px-4 py-3 font-medium text-sh-gray">Zone</th>
                <th className="text-left px-4 py-3 font-medium text-sh-gray">Status</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-sh-gray">
                    No upcoming deliveries
                  </td>
                </tr>
              ) : (
                deliveries.map((d) => (
                  <tr key={d.id} className="border-b border-sh-gray/10 hover:bg-sh-stripe/50">
                    <td className="px-4 py-2 text-sh-black">
                      {d.scheduledDate ? format(new Date(d.scheduledDate), "MMM d, yyyy") : "TBD"}
                    </td>
                    <td className="px-4 py-2 text-sh-gray">{d.scheduledTime || "--"}</td>
                    <td className="px-4 py-2 text-sh-gray">{d.customerName}</td>
                    <td className="px-4 py-2">
                      <Link
                        href={`/app/sales/orders/${d.salesOrderId}`}
                        className="text-sh-blue hover:underline font-medium min-h-[44px] inline-flex items-center"
                      >
                        {d.orderNumber}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-sh-gray">{d.zoneName || "--"}</td>
                    <td className="px-4 py-2">
                      <span
                        className={`text-xs px-2 py-0.5 rounded ${STATUS_STYLES[d.status] || "bg-sh-gray/20 text-sh-gray"}`}
                      >
                        {STATUS_LABELS[d.status] || d.status}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Needs Scheduling */}
      <div>
        <h2 className="text-lg text-sh-black font-semibold mb-3">Needs Scheduling</h2>
        <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-sh-gray/20 bg-sh-stripe">
                <th className="text-left px-4 py-3 font-medium text-sh-gray">Order #</th>
                <th className="text-left px-4 py-3 font-medium text-sh-gray">Customer</th>
                <th className="text-left px-4 py-3 font-medium text-sh-gray">Order Date</th>
                <th className="text-right px-4 py-3 font-medium text-sh-gray">Items</th>
                <th className="text-left px-4 py-3 font-medium text-sh-gray">Days Waiting</th>
              </tr>
            </thead>
            <tbody>
              {needsScheduling.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-sh-gray">
                    All delivery orders are scheduled
                  </td>
                </tr>
              ) : (
                needsScheduling.map((order) => (
                  <tr key={order.id} className="border-b border-sh-gray/10 hover:bg-sh-stripe/50">
                    <td className="px-4 py-2">
                      <Link
                        href={`/app/sales/orders/${order.id}`}
                        className="text-sh-blue hover:underline font-medium min-h-[44px] inline-flex items-center"
                      >
                        {order.orderno}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-sh-gray">{order.customerName}</td>
                    <td className="px-4 py-2 text-sh-gray">
                      {order.orderDate ? format(new Date(order.orderDate), "MMM d, yyyy") : "--"}
                    </td>
                    <td className="px-4 py-2 text-right text-sh-gray">{order.lineItemCount}</td>
                    <td className="px-4 py-2">
                      <span
                        className={`text-xs px-2 py-0.5 rounded ${daysWaitingStyle(order.daysSinceReceived)}`}
                      >
                        {order.daysSinceReceived}d
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Stock Transfers */}
      <div>
        <h2 className="text-lg text-sh-black font-semibold mb-3">Stock Transfers</h2>
        <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-sh-gray/20 bg-sh-stripe">
                <th className="text-left px-4 py-3 font-medium text-sh-gray">From</th>
                <th className="text-left px-4 py-3 font-medium text-sh-gray">To</th>
                <th className="text-right px-4 py-3 font-medium text-sh-gray">Items</th>
                <th className="text-left px-4 py-3 font-medium text-sh-gray">Status</th>
                <th className="text-left px-4 py-3 font-medium text-sh-gray">Shipped</th>
              </tr>
            </thead>
            <tbody>
              {transfers.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-sh-gray">
                    No active transfers
                  </td>
                </tr>
              ) : (
                transfers.map((t) => (
                  <tr key={t.id} className="border-b border-sh-gray/10 hover:bg-sh-stripe/50">
                    <td className="px-4 py-2 text-sh-black">{t.fromLocation}</td>
                    <td className="px-4 py-2 text-sh-gray">{t.toLocation}</td>
                    <td className="px-4 py-2 text-right text-sh-gray">{t.itemCount}</td>
                    <td className="px-4 py-2">
                      <span
                        className={`text-xs px-2 py-0.5 rounded ${STATUS_STYLES[t.status] || "bg-sh-gray/20 text-sh-gray"}`}
                      >
                        {STATUS_LABELS[t.status] || t.status}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-sh-gray">
                      {t.shippedAt ? format(new Date(t.shippedAt), "MMM d, yyyy") : "--"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
