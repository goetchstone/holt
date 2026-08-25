"use client";

// /app/src/app/(dashboard)/app/dispatch/planner/DeliveryPlannerView.tsx
//
// Delivery planner: inbound POs grouped by ESD week within delivery zones, with
// clickable week-filter metric cards and inline pencil-in scheduling. App Router
// port of the legacy pages/dispatch/planner.tsx body (minus MainLayout chrome,
// which comes from the (dashboard) layout). Reads the shared /api/dispatch/* REST
// endpoints.

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import axios from "axios";
import { toast } from "react-toastify";
import { Loader2, ChevronDown, ChevronRight, CalendarPlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";

// --- Types ---

type WeekFilter = "all" | "thisWeek" | "nextWeek" | "later" | "noEsd";

interface OrderRow {
  poId: number;
  poNumber: string;
  vendorName: string;
  expectedDelivery: string | null;
  status: string;
  customerName: string;
  customerId: number | null;
  city: string;
  zipCode: string;
  salesOrderId: number;
  orderno: string;
  lineItemCount: number;
  weekLabel: string;
  weekStart: string | null;
  weekFilter: WeekFilter;
  inStockCount: number;
  inboundCount: number;
  plannedDate: string | null;
}

interface ZoneGroup {
  zoneName: string;
  zoneId: number | null;
  orders: OrderRow[];
}

interface PlannerData {
  summary: {
    total: number;
    dueThisWeek: number;
    dueNextWeek: number;
    dueLater: number;
    noEsd: number;
  };
  zones: ZoneGroup[];
}

// --- Helpers ---

const STATUS_COLORS: Record<string, string> = {
  SUBMITTED: "bg-brand-accent-blue/20 text-brand-accent-blue",
  CONFIRMED: "bg-brand-gold/20 text-brand-gold",
  RECEIVED_PARTIAL: "bg-brand-blue/15 text-brand-blue",
};

const STATUS_LABELS: Record<string, string> = {
  SUBMITTED: "Submitted",
  CONFIRMED: "Confirmed",
  RECEIVED_PARTIAL: "Partial",
};

function formatDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLORS[status] || "bg-brand-gray/15 text-brand-gray";
  const label = STATUS_LABELS[status] || status;
  return (
    <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded ${color}`}>{label}</span>
  );
}

/** Group orders by weekLabel, preserving order within each group. */
function groupByWeek(orders: OrderRow[]): { weekLabel: string; orders: OrderRow[] }[] {
  const map = new Map<string, OrderRow[]>();
  for (const o of orders) {
    if (!map.has(o.weekLabel)) map.set(o.weekLabel, []);
    map.get(o.weekLabel)!.push(o);
  }
  return Array.from(map.entries()).map(([weekLabel, rows]) => ({ weekLabel, orders: rows }));
}

// --- Sub-components ---

function MetricCard({
  label,
  value,
  active,
  highlight,
  onClick,
}: {
  label: string;
  value: number;
  active: boolean;
  highlight?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`bg-white rounded-xl border-2 p-4 text-center transition min-h-[44px] ${
        active ? "border-brand-blue shadow-sm" : "border-brand-gray/15 hover:border-brand-gray/30"
      }`}
    >
      <p className="text-sm text-brand-gray mb-1">{label}</p>
      <p className={`text-2xl font-semibold ${highlight || "text-brand-black"}`}>{value}</p>
    </button>
  );
}

function PencilInButton({
  order,
  onPencilIn,
  onRemove,
}: {
  order: OrderRow;
  onPencilIn: (salesOrderId: number, date: string) => void;
  onRemove: (salesOrderId: number) => void;
}) {
  const [showPicker, setShowPicker] = useState(false);

  if (order.plannedDate) {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRemove(order.salesOrderId);
        }}
        className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-green-100 text-green-700 hover:bg-green-200 transition min-h-[44px]"
        title="Remove pencil-in"
      >
        Planned: {formatShortDate(order.plannedDate)}
        <X className="w-3 h-3" />
      </button>
    );
  }

  if (showPicker) {
    return (
      <input
        type="date"
        autoFocus
        className="border border-brand-gray/30 rounded px-2 py-1 text-xs min-h-[44px] w-32"
        onBlur={() => setShowPicker(false)}
        onChange={(e) => {
          if (e.target.value) {
            onPencilIn(order.salesOrderId, e.target.value);
            setShowPicker(false);
          }
        }}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        setShowPicker(true);
      }}
      className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded text-brand-blue hover:bg-brand-blue/10 transition min-h-[44px]"
      title="Plan delivery date"
    >
      <CalendarPlus className="w-3.5 h-3.5" />
      Plan
    </button>
  );
}

function WeekTable({
  orders,
  onPencilIn,
  onRemove,
}: {
  orders: OrderRow[];
  onPencilIn: (salesOrderId: number, date: string) => void;
  onRemove: (salesOrderId: number) => void;
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-brand-gray/15 bg-brand-stripe">
          <th className="text-left px-4 py-3 font-medium text-brand-gray">PO #</th>
          <th className="text-left px-4 py-3 font-medium text-brand-gray">Vendor</th>
          <th className="text-left px-4 py-3 font-medium text-brand-gray">ESD</th>
          <th className="text-left px-4 py-3 font-medium text-brand-gray">Status</th>
          <th className="text-left px-4 py-3 font-medium text-brand-gray">Customer</th>
          <th className="text-left px-4 py-3 font-medium text-brand-gray">Order #</th>
          <th className="text-right px-4 py-3 font-medium text-brand-gray">Items</th>
          <th className="text-center px-4 py-3 font-medium text-brand-gray">Plan</th>
        </tr>
      </thead>
      <tbody>
        {orders.map((order, idx) => (
          <tr
            key={order.poId}
            className={`border-b border-brand-gray/10 ${idx % 2 === 1 ? "bg-brand-stripe" : ""}`}
          >
            <td className="px-4 py-3">
              <Link
                href={`/app/purchasing/orders/${order.poId}`}
                className="text-brand-blue hover:underline font-medium min-h-[44px] inline-flex items-center"
              >
                {order.poNumber}
              </Link>
            </td>
            <td className="px-4 py-3 text-brand-black">{order.vendorName}</td>
            <td className="px-4 py-3">
              {order.expectedDelivery ? (
                <span className="text-brand-gray">{formatDate(order.expectedDelivery)}</span>
              ) : (
                <span className="text-amber-600 font-medium">No ESD</span>
              )}
            </td>
            <td className="px-4 py-3">
              <StatusBadge status={order.status} />
            </td>
            <td className="px-4 py-3">
              <div className="text-brand-black">{order.customerName}</div>
              <div className="flex items-center gap-1 mt-0.5">
                {order.inStockCount > 0 && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-green-100 text-green-700">
                    {order.inStockCount} in stock
                  </span>
                )}
                {order.inboundCount > 0 && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-brand-blue/10 text-brand-blue">
                    {order.inboundCount} more inbound
                  </span>
                )}
              </div>
            </td>
            <td className="px-4 py-3">
              <Link
                href={`/app/sales/orders/${order.salesOrderId}`}
                className="text-brand-blue hover:underline min-h-[44px] inline-flex items-center"
              >
                {order.orderno}
              </Link>
            </td>
            <td className="px-4 py-3 text-right text-brand-gray">{order.lineItemCount}</td>
            <td className="px-4 py-3 text-center">
              <PencilInButton order={order} onPencilIn={onPencilIn} onRemove={onRemove} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CollapsibleZone({
  zone,
  filter,
  onPencilIn,
  onRemove,
}: {
  zone: ZoneGroup;
  filter: WeekFilter;
  onPencilIn: (salesOrderId: number, date: string) => void;
  onRemove: (salesOrderId: number) => void;
}) {
  const [open, setOpen] = useState(false);

  const filtered =
    filter === "all" ? zone.orders : zone.orders.filter((o) => o.weekFilter === filter);

  if (filtered.length === 0) return null;

  const weeks = groupByWeek(filtered);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full text-left py-2 min-h-[44px] text-brand-black"
      >
        {open ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
        <span className="text-lg font-semibold">
          {zone.zoneName} ({filtered.length})
        </span>
      </button>
      {open && (
        <div className="mt-2 space-y-4">
          {weeks.map((week) => (
            <div key={week.weekLabel}>
              <h4 className="text-sm font-semibold text-brand-gray uppercase tracking-wide mb-2 pl-2">
                {week.weekLabel}
                <span className="ml-2 font-normal text-brand-gray/70">({week.orders.length})</span>
              </h4>
              <div className="bg-white rounded-xl border border-brand-gray/15 overflow-hidden">
                <WeekTable orders={week.orders} onPencilIn={onPencilIn} onRemove={onRemove} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --- View ---

export function DeliveryPlannerView() {
  const [data, setData] = useState<PlannerData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [activeFilter, setActiveFilter] = useState<WeekFilter>("all");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await axios.get<PlannerData>("/api/dispatch/delivery-planner");
      setData(res.data);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  function toggleFilter(filter: WeekFilter) {
    setActiveFilter((prev) => (prev === filter ? "all" : filter));
  }

  async function handlePencilIn(salesOrderId: number, date: string) {
    try {
      await axios.post("/api/dispatch/pencil-in", { salesOrderId, date });
      toast.success("Delivery planned");
      fetchData();
    } catch (err: unknown) {
      const msg =
        axios.isAxiosError(err) && err.response?.data?.error
          ? err.response.data.error
          : "Failed to plan delivery";
      toast.error(msg);
    }
  }

  async function handleRemove(salesOrderId: number) {
    try {
      await axios.delete("/api/dispatch/pencil-in", { data: { salesOrderId } });
      toast.success("Plan removed");
      fetchData();
    } catch (err: unknown) {
      const msg =
        axios.isAxiosError(err) && err.response?.data?.error
          ? err.response.data.error
          : "Failed to remove plan";
      toast.error(msg);
    }
  }

  if (loading) {
    return (
      <div className="py-2 font-serif">
        <div className="flex items-center gap-3">
          <Loader2 className="w-5 h-5 animate-spin text-brand-gray" />
          <p className="text-brand-gray">Loading delivery planner...</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="py-2 font-serif">
        <p className="text-brand-gray mb-4">Failed to load delivery planner.</p>
        <Button variant="outline" onClick={fetchData}>
          Retry
        </Button>
      </div>
    );
  }

  const { summary, zones } = data;

  return (
    <div className="py-2 space-y-6 font-serif">
      {/* Breadcrumb */}
      <nav className="text-sm text-brand-gray">
        <Link href="/app/dispatch" className="hover:underline">
          Dispatch
        </Link>
        <span className="mx-2">/</span>
        <span className="text-brand-black">Delivery Planner</span>
      </nav>

      {/* Header with nav links */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="font-serif text-2xl text-brand-navy">Delivery Planner</h1>
        <div className="flex items-center gap-2">
          <Link href="/app/dispatch">
            <Button variant="outline" size="sm">
              Dispatch Board
            </Button>
          </Link>
          <Link href="/app/dispatch/ready-to-deliver">
            <Button variant="outline" size="sm">
              Ready to Deliver
            </Button>
          </Link>
        </div>
      </div>

      {/* Summary cards — clickable filters */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
        <MetricCard
          label="Total Inbound"
          value={summary.total}
          active={activeFilter === "all"}
          onClick={() => setActiveFilter("all")}
        />
        <MetricCard
          label="Due This Week"
          value={summary.dueThisWeek}
          active={activeFilter === "thisWeek"}
          highlight="text-brand-blue"
          onClick={() => toggleFilter("thisWeek")}
        />
        <MetricCard
          label="Due Next Week"
          value={summary.dueNextWeek}
          active={activeFilter === "nextWeek"}
          onClick={() => toggleFilter("nextWeek")}
        />
        <MetricCard
          label="2-4 Weeks"
          value={summary.dueLater}
          active={activeFilter === "later"}
          onClick={() => toggleFilter("later")}
        />
        <MetricCard
          label="No ESD"
          value={summary.noEsd}
          active={activeFilter === "noEsd"}
          highlight={summary.noEsd > 0 ? "text-amber-700" : undefined}
          onClick={() => toggleFilter("noEsd")}
        />
      </div>

      {/* Zone sections */}
      <div className="space-y-4">
        {zones.map((zone) => (
          <CollapsibleZone
            key={zone.zoneName}
            zone={zone}
            filter={activeFilter}
            onPencilIn={handlePencilIn}
            onRemove={handleRemove}
          />
        ))}
      </div>

      {summary.total === 0 && (
        <p className="text-brand-gray text-center py-8">No inbound purchase orders.</p>
      )}
    </div>
  );
}
