"use client";

// /app/src/app/(dashboard)/app/dispatch/DispatchBoardView.tsx
//
// Delivery dispatch board with drag-and-drop order assignment to truck runs.
// App Router port of the legacy pages/dispatch/index.tsx body (minus TopNav +
// MainLayout chrome, which comes from the (dashboard) layout). Keeps all @dnd-kit
// drag handlers verbatim and reads the shared /api/dispatch/* REST endpoints.

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import axios from "axios";
import { toast } from "react-toastify";
import { format, addDays, subDays } from "date-fns";
import Link from "next/link";
import { ChevronLeft, ChevronRight, ChevronDown, Truck, Package, Loader2 } from "lucide-react";
import { DndBoard } from "@/components/dnd/DndBoard";
import { DroppableColumn } from "@/components/dnd/DroppableColumn";
import { SortableList } from "@/components/dnd/SortableList";
import { SortableItem } from "@/components/dnd/SortableItem";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";

// --- Types ---

type DispatchLineItem = {
  id: number;
  partNo: string | null;
  productName: string | null;
  orderedQuantity: number;
  status: string | null;
};

type DispatchOrderPO = {
  id: number;
  poNumber: string;
  status: string;
  expectedDelivery: string | null;
};

type DispatchOrder = {
  id: number;
  orderno: string;
  orderDate: string;
  lineItemCount: number;
  inStock: boolean;
  lineItems: DispatchLineItem[];
  purchaseOrders: DispatchOrderPO[];
  balanceDue: number;
};

type DispatchCustomer = {
  customerId: number | null;
  customerName: string;
  address: string | null;
  city: string | null;
  zipCode: string | null;
  zoneName: string | null;
  zoneId: number | null;
  orders: DispatchOrder[];
  totalItems: number;
  allInStock: boolean;
  totalBalanceDue: number;
};

type ZoneGroup = {
  zoneName: string;
  customers: DispatchCustomer[];
};

// Keep Delivery type for stops that are already on runs
type Delivery = {
  id: number;
  appointmentNumber: string;
  customer: {
    id: number;
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
  } | null;
  address: { address1: string; city: string; state: string; zip: string } | null;
  salesOrder: {
    id: number;
    orderno: string;
    customer?: { firstName: string | null; lastName: string | null };
    _count?: { lineItems: number };
    lineItems?: { id: number; productName: string | null; orderedQuantity: number }[];
  } | null;
  deliveryZone: { id: number; name: string } | null;
};

type Vehicle = {
  id: number;
  name: string;
  type: string;
  capacity: number;
  isActive: boolean;
};

type RunStop = {
  id: number;
  stopOrder: number;
  status: string;
  serviceAppointment: Delivery;
};

type DeliveryRun = {
  id: number;
  runNumber: string;
  runDate: string;
  vehicleId: number;
  status: string;
  driver: { id: number; displayName: string } | null;
  vehicle: Vehicle;
  stops: RunStop[];
};

// --- Helpers ---

function getCustomerName(delivery: Delivery): string {
  if (delivery.customer) {
    return (
      `${delivery.customer.firstName || ""} ${delivery.customer.lastName || ""}`.trim() || "Unknown"
    );
  }
  if (delivery.salesOrder?.customer) {
    return (
      `${delivery.salesOrder.customer.firstName || ""} ${delivery.salesOrder.customer.lastName || ""}`.trim() ||
      "Unknown"
    );
  }
  return "Unknown";
}

function getItemCount(delivery: Delivery): number {
  return delivery.salesOrder?._count?.lineItems ?? delivery.salesOrder?.lineItems?.length ?? 0;
}

function findRunContaining(runs: DeliveryRun[], stopId: number): DeliveryRun | undefined {
  return runs.find((r) => r.stops.some((s) => s.id === stopId));
}

function getCustomerKey(c: DispatchCustomer): string {
  return c.customerId ? String(c.customerId) : `${c.customerName}-${c.zipCode}`;
}

// --- Component ---

export function DispatchBoardView() {
  const fmt = useMoneyFormatter();
  const [selectedDate, setSelectedDate] = useState(() => format(new Date(), "yyyy-MM-dd"));
  const [zones, setZones] = useState<ZoneGroup[]>([]);
  const [unzoned, setUnzoned] = useState<DispatchCustomer[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [runs, setRuns] = useState<DeliveryRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [showInStockOnly, setShowInStockOnly] = useState(true);
  const [expandedOrder, setExpandedOrder] = useState<number | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [ordersRes, runsRes, vehiclesRes] = await Promise.all([
        axios.get("/api/dispatch/orders-by-zone"),
        axios.get(`/api/dispatch/runs?date=${selectedDate}&include=stops`),
        axios.get("/api/dispatch/vehicles?isActive=true"),
      ]);
      setZones(ordersRes.data.zones || []);
      setUnzoned(ordersRes.data.unzoned || []);
      setRuns(runsRes.data.runs || []);
      setVehicles(vehiclesRes.data.vehicles || []);
    } catch {
      toast.error("Failed to load dispatch data");
    } finally {
      setLoading(false);
    }
  }, [selectedDate]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  function prevDay() {
    setSelectedDate((d) => format(subDays(new Date(d + "T12:00:00"), 1), "yyyy-MM-dd"));
  }

  function nextDay() {
    setSelectedDate((d) => format(addDays(new Date(d + "T12:00:00"), 1), "yyyy-MM-dd"));
  }

  function toggleZone(name: string) {
    setExpanded((prev) => ({ ...prev, [name]: !prev[name] }));
  }

  // Find the customer or stop for the active drag
  function findActiveItem(id: string): { name: string; city: string } | null {
    if (id.startsWith("customer-")) {
      const custKey = id.replace("customer-", "");
      for (const z of zones) {
        const c = z.customers.find((cust) => getCustomerKey(cust) === custKey);
        if (c) return { name: c.customerName, city: c.city || "" };
      }
      const c = unzoned.find((cust) => getCustomerKey(cust) === custKey);
      if (c) return { name: c.customerName, city: c.city || "" };
    }
    if (id.startsWith("stop-")) {
      const stopId = Number.parseInt(id.replace("stop-", ""));
      for (const r of runs) {
        const s = r.stops.find((st) => st.id === stopId);
        if (s)
          return {
            name: getCustomerName(s.serviceAppointment),
            city: s.serviceAppointment.address?.city || "",
          };
      }
    }
    return null;
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;

    const activeIdStr = String(active.id);
    const overIdStr = String(over.id);

    // Determine source and target
    const isFromUnassigned = activeIdStr.startsWith("customer-");
    const isFromRun = activeIdStr.startsWith("stop-");

    // Find target run
    let targetRunId: number | null = null;
    if (overIdStr.startsWith("run-")) {
      targetRunId = Number.parseInt(overIdStr.replace("run-", ""));
    } else if (overIdStr.startsWith("stop-")) {
      const stopId = Number.parseInt(overIdStr.replace("stop-", ""));
      const targetRun = findRunContaining(runs, stopId);
      if (targetRun) targetRunId = targetRun.id;
    }

    // Dropping back onto unassigned — no action
    if (overIdStr.startsWith("zone-") || overIdStr.startsWith("customer-")) return;

    // Drag customer from unassigned to a run — assign all their orders
    if (isFromUnassigned && targetRunId) {
      const custKey = activeIdStr.replace("customer-", "");
      const allCustomers = [...zones.flatMap((z) => z.customers), ...unzoned];
      const customer = allCustomers.find((c) => getCustomerKey(c) === custKey);
      if (!customer) return;
      for (const order of customer.orders) {
        await assignOrderToRun(targetRunId, order.id);
      }
      return;
    }

    // Drag stop within same run (reorder)
    if (isFromRun && targetRunId) {
      const stopId = Number.parseInt(activeIdStr.replace("stop-", ""));
      const sourceRun = findRunContaining(runs, stopId);
      if (!sourceRun) return;

      if (sourceRun.id === targetRunId) {
        // Reorder within same run
        const oldIndex = sourceRun.stops.findIndex((s) => s.id === stopId);
        let newIndex = sourceRun.stops.length - 1;
        if (overIdStr.startsWith("stop-")) {
          const overStopId = Number.parseInt(overIdStr.replace("stop-", ""));
          newIndex = sourceRun.stops.findIndex((s) => s.id === overStopId);
        }
        if (oldIndex === newIndex) return;

        const newStops = arrayMove(sourceRun.stops, oldIndex, newIndex);
        // Optimistic update
        setRuns((prev) => prev.map((r) => (r.id === targetRunId ? { ...r, stops: newStops } : r)));

        try {
          await axios.put(`/api/dispatch/runs/${targetRunId}/stops`, {
            stopIds: newStops.map((s) => s.id),
          });
        } catch {
          toast.error("Failed to reorder stops");
          fetchData();
        }
        return;
      }

      // Move between runs
      const stop = sourceRun.stops.find((s) => s.id === stopId);
      if (!stop) return;

      // Optimistic: remove from source, add to target
      setRuns((prev) =>
        prev.map((r) => {
          if (r.id === sourceRun.id) return { ...r, stops: r.stops.filter((s) => s.id !== stopId) };
          if (r.id === targetRunId)
            return { ...r, stops: [...r.stops, { ...stop, stopOrder: r.stops.length + 1 }] };
          return r;
        }),
      );

      try {
        await axios.delete(`/api/dispatch/runs/${sourceRun.id}/stops?stopId=${stopId}`);
        await axios.post(`/api/dispatch/runs/${targetRunId}/stops`, {
          serviceAppointmentId: stop.serviceAppointment.id,
        });
      } catch {
        toast.error("Failed to move stop");
        fetchData();
      }
    }
  }

  async function assignOrderToRun(runId: number, salesOrderId: number) {
    try {
      await axios.post("/api/dispatch/assign-order", { salesOrderId, runId });
    } catch {
      toast.error("Failed to assign order");
    }
    // Refetch to update both sides
    fetchData();
  }

  async function createRun(vehicleId: number) {
    try {
      await axios.post("/api/dispatch/runs", {
        runDate: selectedDate,
        vehicleId,
      });
      fetchData();
    } catch {
      toast.error("Failed to create run");
    }
  }

  // Apply in-stock filter
  const filterCustomers = (customers: DispatchCustomer[]) =>
    showInStockOnly ? customers.filter((c) => c.allInStock) : customers;

  const filteredZones = zones
    .map((z) => ({ ...z, customers: filterCustomers(z.customers) }))
    .filter((z) => z.customers.length > 0);
  const filteredUnzoned = filterCustomers(unzoned);

  const totalUnassigned =
    filteredZones.reduce((sum, z) => sum + z.customers.length, 0) + filteredUnzoned.length;
  const totalAll = zones.reduce((sum, z) => sum + z.customers.length, 0) + unzoned.length;
  const inStockCount = zones
    .flatMap((z) => z.customers)
    .concat(unzoned)
    .filter((c) => c.allInStock).length;

  const displayDate = format(new Date(selectedDate + "T12:00:00"), "EEEE, MMMM d, yyyy");

  const activeItem = activeId ? findActiveItem(activeId) : null;

  // Vehicles without runs on this date
  const vehiclesWithoutRuns = vehicles.filter((v) => !runs.some((r) => r.vehicleId === v.id));

  return (
    <div className="font-serif">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <h1 className="text-2xl text-sh-navy font-semibold">Delivery Dispatch</h1>
        <div className="flex items-center gap-2">
          <Link href="/app/dispatch/ready-to-deliver">
            <span className="px-4 py-2 text-sm font-semibold border border-sh-navy text-sh-navy rounded-lg hover:bg-sh-linen transition min-h-[44px] flex items-center cursor-pointer">
              Ready to Deliver
            </span>
          </Link>
          <Link href="/app/dispatch/planner">
            <span className="px-4 py-2 text-sm font-semibold border border-sh-navy text-sh-navy rounded-lg hover:bg-sh-linen transition min-h-[44px] flex items-center cursor-pointer">
              Planner
            </span>
          </Link>
        </div>
      </div>

      {/* Date picker */}
      <div className="flex items-center gap-3 mb-5">
        <button
          onClick={prevDay}
          className="p-3 rounded-lg border border-sh-gray/20 hover:bg-sh-linen transition min-w-[44px] min-h-[44px] flex items-center justify-center"
        >
          <ChevronLeft className="w-5 h-5 text-sh-navy" />
        </button>
        <input
          type="date"
          value={selectedDate}
          onChange={(e) => setSelectedDate(e.target.value)}
          className="border border-sh-gray/30 rounded-lg px-3 py-2 text-sm min-h-[44px]"
        />
        <span className="text-sh-gray text-sm hidden sm:inline">{displayDate}</span>
        <button
          onClick={nextDay}
          className="p-3 rounded-lg border border-sh-gray/20 hover:bg-sh-linen transition min-w-[44px] min-h-[44px] flex items-center justify-center"
        >
          <ChevronRight className="w-5 h-5 text-sh-navy" />
        </button>
      </div>

      {/* Filter bar */}
      {!loading && (
        <div className="flex items-center gap-4 mb-4">
          <label className="flex items-center gap-2 text-sm text-sh-gray cursor-pointer min-h-[44px]">
            <input
              type="checkbox"
              checked={showInStockOnly}
              onChange={(e) => setShowInStockOnly(e.target.checked)}
              className="w-5 h-5 accent-sh-blue"
            />
            In-stock only
          </label>
          <span className="text-sm text-sh-gray">
            {inStockCount} in-stock / {totalAll} total
          </span>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-sh-blue mr-3" />
          <span className="text-sh-gray">Loading dispatch board...</span>
        </div>
      ) : (
        <DndBoard
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          overlayContent={
            activeItem ? (
              <div className="bg-white border-2 border-sh-gold rounded-lg p-3 shadow-xl w-64 opacity-90">
                <div className="font-semibold text-sh-navy text-sm">{activeItem.name}</div>
                <div className="text-xs text-sh-gray">{activeItem.city || "—"}</div>
              </div>
            ) : null
          }
        >
          <div className="grid grid-cols-[320px_1fr] gap-6">
            {/* Left: Unassigned by zone */}
            <div className="overflow-y-auto max-h-[calc(100vh-220px)]">
              <h2 className="text-lg text-sh-navy font-semibold mb-3 flex items-center gap-2">
                <Package className="w-5 h-5" />
                Unassigned
                {totalUnassigned > 0 && (
                  <span className="bg-sh-gold text-white text-xs font-sans px-2 py-0.5 rounded-full">
                    {totalUnassigned}
                  </span>
                )}
              </h2>

              {totalUnassigned === 0 ? (
                <div className="bg-white border border-sh-gray/10 rounded-lg p-6 text-center text-sh-gray text-sm">
                  No unassigned deliveries
                </div>
              ) : (
                <div className="space-y-3">
                  {filteredZones.map((zone) => (
                    <div key={zone.zoneName}>
                      <button
                        onClick={() => toggleZone(zone.zoneName)}
                        className="flex items-center gap-2 mb-2 min-h-[44px] w-full text-left"
                      >
                        <ChevronDown
                          className={`w-4 h-4 text-sh-gray transition ${expanded[zone.zoneName] ? "" : "-rotate-90"}`}
                        />
                        <span className="text-sm font-semibold text-sh-gray uppercase tracking-wide">
                          {zone.zoneName}
                        </span>
                        <span className="text-xs text-sh-gray">({zone.customers.length})</span>
                      </button>
                      {expanded[zone.zoneName] && (
                        <DroppableColumn id={`zone-${zone.zoneName}`} emptyMessage="All assigned">
                          <SortableList
                            items={zone.customers.map((c) => `customer-${getCustomerKey(c)}`)}
                          >
                            {zone.customers.map((c) => (
                              <SortableItem
                                key={getCustomerKey(c)}
                                id={`customer-${getCustomerKey(c)}`}
                              >
                                <CustomerCard
                                  customer={c}
                                  expandedOrder={expandedOrder}
                                  onToggleOrder={(id) =>
                                    setExpandedOrder(expandedOrder === id ? null : id)
                                  }
                                  fmt={fmt}
                                />
                              </SortableItem>
                            ))}
                          </SortableList>
                        </DroppableColumn>
                      )}
                    </div>
                  ))}
                  {filteredUnzoned.length > 0 && (
                    <div>
                      <button
                        onClick={() => toggleZone("unzoned")}
                        className="flex items-center gap-2 mb-2 min-h-[44px] w-full text-left"
                      >
                        <ChevronDown
                          className={`w-4 h-4 text-sh-gray transition ${expanded["unzoned"] ? "" : "-rotate-90"}`}
                        />
                        <span className="text-sm font-semibold text-sh-gray uppercase tracking-wide">
                          No Zone
                        </span>
                        <span className="text-xs text-sh-gray">({filteredUnzoned.length})</span>
                      </button>
                      {expanded["unzoned"] && (
                        <DroppableColumn id="zone-unzoned" emptyMessage="All assigned">
                          <SortableList
                            items={filteredUnzoned.map((c) => `customer-${getCustomerKey(c)}`)}
                          >
                            {filteredUnzoned.map((c) => (
                              <SortableItem
                                key={getCustomerKey(c)}
                                id={`customer-${getCustomerKey(c)}`}
                              >
                                <CustomerCard
                                  customer={c}
                                  expandedOrder={expandedOrder}
                                  onToggleOrder={(id) =>
                                    setExpandedOrder(expandedOrder === id ? null : id)
                                  }
                                  fmt={fmt}
                                />
                              </SortableItem>
                            ))}
                          </SortableList>
                        </DroppableColumn>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Right: Trucks */}
            <div className="overflow-y-auto max-h-[calc(100vh-220px)]">
              <h2 className="text-lg text-sh-navy font-semibold mb-3 flex items-center gap-2">
                <Truck className="w-5 h-5" />
                Trucks
              </h2>

              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                {runs.map((run) => (
                  <div
                    key={run.id}
                    className="bg-white border border-sh-gray/10 rounded-lg overflow-hidden"
                  >
                    {/* Truck header */}
                    <div className="px-4 py-3 bg-sh-linen border-b border-sh-gray/10 flex items-center justify-between">
                      <div>
                        <h3 className="font-semibold text-sh-navy">{run.vehicle.name}</h3>
                        <span className="text-xs text-sh-gray">
                          {run.driver?.displayName || "No driver"} — {run.stops.length}{" "}
                          {run.stops.length === 1 ? "stop" : "stops"}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <StatusBadge status={run.status} />
                        <Link
                          href={`/app/dispatch/run/${run.id}`}
                          className="text-xs text-sh-blue hover:underline min-h-[44px] flex items-center"
                        >
                          Details
                        </Link>
                      </div>
                    </div>

                    {/* Droppable stop list */}
                    <div className="p-3">
                      <DroppableColumn id={`run-${run.id}`} emptyMessage="Drag deliveries here">
                        <SortableList items={run.stops.map((s) => `stop-${s.id}`)}>
                          {run.stops.map((stop) => (
                            <SortableItem key={stop.id} id={`stop-${stop.id}`}>
                              <StopCard stop={stop} />
                            </SortableItem>
                          ))}
                        </SortableList>
                      </DroppableColumn>
                    </div>
                  </div>
                ))}

                {/* Vehicles without runs — show create button */}
                {vehiclesWithoutRuns.map((v) => (
                  <div
                    key={v.id}
                    className="bg-white border border-dashed border-sh-gray/30 rounded-lg p-4 flex items-center justify-between"
                  >
                    <div>
                      <h3 className="font-semibold text-sh-gray">{v.name}</h3>
                      <span className="text-xs text-sh-gray">No run for this date</span>
                    </div>
                    <Button size="sm" onClick={() => createRun(v.id)}>
                      Create Run
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </DndBoard>
      )}
    </div>
  );
}

function CustomerCard({
  customer,
  expandedOrder,
  onToggleOrder,
  fmt,
}: {
  customer: DispatchCustomer;
  expandedOrder: number | null;
  onToggleOrder: (id: number) => void;
  fmt: (value: number | null | undefined, opts?: { whole?: boolean }) => string;
}) {
  const hasMultiple = customer.orders.length > 1;

  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-semibold text-sh-navy text-sm truncate">{customer.customerName}</div>
          <div className="text-xs text-sh-gray truncate">{customer.city || "—"}</div>
          {!customer.allInStock && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 mt-0.5 inline-block">
              Pending Items
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {hasMultiple && (
            <span className="bg-sh-gold/20 text-sh-gold text-xs px-2 py-0.5 rounded-full font-semibold">
              {customer.orders.length} orders
            </span>
          )}
          <span className="bg-sh-linen text-sh-navy text-xs px-2 py-0.5 rounded-full">
            {customer.totalItems}
          </span>
          {customer.totalBalanceDue > 0 && (
            <span className="bg-red-50 text-red-700 text-xs px-2 py-0.5 rounded-full font-semibold">
              {fmt(customer.totalBalanceDue)}
            </span>
          )}
        </div>
      </div>

      {/* Orders within this customer */}
      <div className="mt-1.5 space-y-1.5">
        {customer.orders.map((order) => {
          const isExpanded = expandedOrder === order.id;
          return (
            <div key={order.id} className="border-t border-sh-gray/10 pt-1">
              <div
                className="flex items-center justify-between cursor-pointer"
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleOrder(order.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    e.stopPropagation();
                    onToggleOrder(order.id);
                  }
                }}
              >
                <div className="flex items-center gap-2">
                  <Link
                    href={`/app/sales/orders/${order.id}`}
                    className="text-xs text-sh-blue hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {order.orderno}
                  </Link>
                  <span className="text-xs text-sh-gray">{order.lineItemCount} items</span>
                  {order.balanceDue > 0 && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-red-50 text-red-700 font-semibold">
                      {fmt(order.balanceDue)}
                    </span>
                  )}
                  {!order.inStock && (
                    <span className="text-xs px-1 py-0.5 rounded bg-amber-100 text-amber-700">
                      Pending
                    </span>
                  )}
                </div>
                <ChevronDown
                  className={`w-3.5 h-3.5 text-sh-gray transition ${isExpanded ? "" : "-rotate-90"}`}
                />
              </div>

              {isExpanded && (
                <div className="mt-1 pl-2 space-y-0.5">
                  {order.lineItems.map((li) => (
                    <div key={li.id} className="flex items-center justify-between text-xs">
                      <span className="text-sh-black truncate">
                        {li.productName || li.partNo || "—"}
                      </span>
                      <span className="text-sh-gray flex-shrink-0 ml-2">x{li.orderedQuantity}</span>
                    </div>
                  ))}
                  {order.purchaseOrders.length > 0 && (
                    <div className="border-t border-sh-gray/10 pt-0.5 mt-0.5">
                      {order.purchaseOrders.map((po) => (
                        <div key={po.id} className="flex items-center gap-1.5 text-xs">
                          <Link
                            href={`/app/purchasing/orders/${po.id}`}
                            className="text-sh-blue hover:underline font-mono"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {po.poNumber}
                          </Link>
                          <span
                            className={`px-1.5 py-0.5 rounded ${
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
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StopCard({ stop }: { stop: RunStop }) {
  const delivery = stop.serviceAppointment;
  const customerName = getCustomerName(delivery);
  const itemCount = getItemCount(delivery);

  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs text-sh-gray font-mono">#{stop.stopOrder}</span>
            <span className="font-semibold text-sh-navy text-sm truncate">{customerName}</span>
          </div>
          <div className="text-xs text-sh-gray truncate">
            {delivery.address?.city || "—"}
            {delivery.salesOrder && (
              <Link
                href={`/app/sales/orders/${delivery.salesOrder.id}`}
                className="ml-1.5 text-sh-blue hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                {delivery.salesOrder.orderno}
              </Link>
            )}
          </div>
        </div>
        {itemCount > 0 && (
          <span className="bg-sh-linen text-sh-navy text-xs px-2 py-0.5 rounded-full flex-shrink-0">
            {itemCount}
          </span>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    PLANNING: "bg-sh-linen text-sh-gray",
    LOADED: "bg-sh-gold/10 text-sh-gold",
    IN_PROGRESS: "bg-sh-blue/10 text-sh-blue",
    COMPLETED: "bg-green-50 text-green-700",
  };

  return (
    <span
      className={`text-xs px-2 py-0.5 rounded-full ${colors[status] || "bg-sh-linen text-sh-gray"}`}
    >
      {status.replace("_", " ")}
    </span>
  );
}
