"use client";

// /app/src/app/(dashboard)/app/dispatch/ready-to-deliver/ReadyToDeliverView.tsx
//
// Ready to Deliver: in-stock orders grouped by delivery zone with summary cards,
// days-waiting badges, and schedule status. App Router port of the legacy
// pages/dispatch/ready-to-deliver.tsx body (minus MainLayout chrome, which comes
// from the (dashboard) layout). Reads the shared /api/dispatch/ready-to-deliver
// REST endpoint.

import { useState, useEffect } from "react";
import Link from "next/link";
import axios from "axios";
import { Loader2, ChevronDown, ChevronRight } from "lucide-react";

interface ReadyOrder {
  id: number;
  orderno: string;
  orderDate: string;
  customerName: string;
  address: string;
  city: string;
  zipCode: string;
  lineItemCount: number;
  isScheduled: boolean;
  scheduledDate: string | null;
  daysSinceReceived: number;
  storeName: string | null;
}

interface ZoneGroup {
  zoneName: string;
  zoneId: number | null;
  orders: ReadyOrder[];
}

interface Summary {
  total: number;
  scheduled: number;
  unscheduled: number;
  zones: number;
}

export function ReadyToDeliverView() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary>({
    total: 0,
    scheduled: 0,
    unscheduled: 0,
    zones: 0,
  });
  const [zones, setZones] = useState<ZoneGroup[]>([]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    async function fetchData() {
      try {
        const res = await axios.get("/api/dispatch/ready-to-deliver");
        setSummary(res.data.summary);
        setZones(res.data.zones);
      } catch {
        setError("Failed to load delivery data");
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, []);

  function toggleZone(zoneName: string) {
    setCollapsed((prev) => ({ ...prev, [zoneName]: !prev[zoneName] }));
  }

  return (
    <>
      <div className="mb-6">
        {/* Breadcrumb */}
        <div className="text-sm text-sh-gray mb-2">
          <Link href="/app/dispatch" className="hover:text-sh-navy">
            Dispatch
          </Link>
          <span className="mx-1">/</span>
          <span className="text-sh-navy">Ready to Deliver</span>
        </div>

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <h1 className="font-serif text-2xl text-sh-navy">Ready to Deliver</h1>
          <div className="flex items-center gap-2">
            <Link
              href="/app/dispatch"
              className="inline-flex items-center justify-center rounded-lg border border-sh-gray/30 px-4 py-2 text-sm font-semibold text-sh-navy hover:bg-sh-linen transition min-h-[44px]"
            >
              Dispatch Board
            </Link>
            <Link
              href="/app/dispatch/planner"
              className="inline-flex items-center justify-center rounded-lg border border-sh-gray/30 px-4 py-2 text-sm font-semibold text-sh-navy hover:bg-sh-linen transition min-h-[44px]"
            >
              Delivery Planner
            </Link>
          </div>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <SummaryCard label="Total Orders" value={summary.total} />
        <SummaryCard label="Scheduled" value={summary.scheduled} />
        <SummaryCard
          label="Needs Scheduling"
          value={summary.unscheduled}
          highlight={summary.unscheduled > 0}
        />
        <SummaryCard label="Zones" value={summary.zones} />
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 text-sh-gray animate-spin" />
        </div>
      ) : error ? (
        <div className="bg-white border border-sh-gray/10 rounded-lg p-8 text-center text-sh-gray">
          {error}
        </div>
      ) : zones.length === 0 ? (
        <div className="bg-white border border-sh-gray/10 rounded-lg p-8 text-center text-sh-gray">
          No orders ready for delivery
        </div>
      ) : (
        <div className="space-y-4">
          {zones.map((zone) => {
            const isCollapsed = collapsed[zone.zoneName] ?? false;
            return (
              <div
                key={zone.zoneName}
                className="bg-white border border-sh-gray/10 rounded-lg overflow-hidden"
              >
                {/* Zone Header */}
                <button
                  onClick={() => toggleZone(zone.zoneName)}
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-sh-linen transition min-h-[44px]"
                >
                  <div className="flex items-center gap-2">
                    {isCollapsed ? (
                      <ChevronRight className="w-5 h-5 text-sh-gray" />
                    ) : (
                      <ChevronDown className="w-5 h-5 text-sh-gray" />
                    )}
                    <h2 className="font-serif text-lg text-sh-navy">{zone.zoneName}</h2>
                    <span className="bg-sh-linen text-sh-navy text-xs font-sans px-2 py-0.5 rounded-full">
                      {zone.orders.length} {zone.orders.length === 1 ? "order" : "orders"}
                    </span>
                  </div>
                </button>

                {/* Zone Table */}
                {!isCollapsed && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-t border-sh-gray/10 bg-sh-stripe text-left text-sh-gray">
                          <th className="px-4 py-2 font-medium">Order</th>
                          <th className="px-4 py-2 font-medium">Customer</th>
                          <th className="px-4 py-2 font-medium hidden sm:table-cell">Address</th>
                          <th className="px-4 py-2 font-medium hidden md:table-cell">City</th>
                          <th className="px-4 py-2 font-medium hidden lg:table-cell">Store</th>
                          <th className="px-4 py-2 font-medium text-center">Days Waiting</th>
                          <th className="px-4 py-2 font-medium">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {zone.orders.map((order, idx) => (
                          <tr
                            key={order.id}
                            className={idx % 2 === 1 ? "bg-sh-stripe" : "bg-white"}
                          >
                            <td className="px-4 py-3">
                              <Link
                                href={`/app/sales/orders/${order.id}`}
                                className="text-sh-blue hover:underline font-medium min-h-[44px] inline-flex items-center"
                              >
                                {order.orderno}
                              </Link>
                            </td>
                            <td className="px-4 py-3 text-sh-navy">{order.customerName}</td>
                            <td className="px-4 py-3 text-sh-gray hidden sm:table-cell">
                              {order.address}
                            </td>
                            <td className="px-4 py-3 text-sh-gray hidden md:table-cell">
                              {order.city}
                            </td>
                            <td className="px-4 py-3 text-sh-gray hidden lg:table-cell">
                              {order.storeName || "-"}
                            </td>
                            <td className="px-4 py-3 text-center">
                              <DaysWaitingBadge days={order.daysSinceReceived} />
                            </td>
                            <td className="px-4 py-3">
                              <ScheduleStatus
                                isScheduled={order.isScheduled}
                                scheduledDate={order.scheduledDate}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function SummaryCard({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: number;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border p-4 ${
        highlight ? "border-amber-300 bg-amber-50" : "border-sh-gray/10 bg-white"
      }`}
    >
      <div className="text-sm text-sh-gray">{label}</div>
      <div className={`font-serif text-2xl mt-1 ${highlight ? "text-amber-700" : "text-sh-navy"}`}>
        {value}
      </div>
    </div>
  );
}

function DaysWaitingBadge({ days }: { days: number }) {
  let colorClasses: string;
  if (days < 3) {
    colorClasses = "bg-green-50 text-green-700";
  } else if (days <= 7) {
    colorClasses = "bg-amber-50 text-amber-700";
  } else {
    colorClasses = "bg-red-50 text-red-700";
  }

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colorClasses}`}
    >
      {days}d
    </span>
  );
}

function ScheduleStatus({
  isScheduled,
  scheduledDate,
}: {
  isScheduled: boolean;
  scheduledDate: string | null;
}) {
  if (isScheduled && scheduledDate) {
    return <span className="text-xs text-green-700">{scheduledDate}</span>;
  }
  return <span className="text-xs font-medium text-amber-600">Needs Scheduling</span>;
}
