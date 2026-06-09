"use client";

// /app/src/app/(dashboard)/app/dispatch/run/[id]/RunDetailView.tsx
//
// Delivery run detail: stops list with reorder/remove, driver assignment, status
// progression, pick-list generation, and an add-stop modal. App Router port of
// the legacy pages/dispatch/run/[id].tsx body (minus MainLayout chrome, which
// comes from the (dashboard) layout). The dynamic id arrives as a prop from the
// server page. Reads the shared /api/dispatch/* + /api/staff REST endpoints.

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import axios from "axios";
import { toast } from "react-toastify";
import { format } from "date-fns";
import Link from "next/link";
import { ArrowUp, ArrowDown, Trash2, Plus, FileText, Phone } from "lucide-react";

type LineItem = {
  id: number;
  productName: string | null;
  orderedQuantity: number;
};

type Customer = {
  id: number;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
};

type Address = {
  address1: string;
  city: string;
  state: string;
  zip: string;
};

type ServiceAppointment = {
  id: number;
  appointmentNumber: string;
  customer: Customer | null;
  address: Address | null;
  deliveryZoneId: number | null;
  deliveryZone?: { name: string } | null;
  salesOrder: {
    id: number;
    orderno: string;
    lineItems: LineItem[];
  } | null;
};

type Stop = {
  id: number;
  stopOrder: number;
  status: string;
  serviceAppointment: ServiceAppointment;
};

type StaffMember = {
  id: number;
  displayName: string;
};

type DeliveryRun = {
  id: number;
  runNumber: string;
  runDate: string;
  status: string;
  notes: string | null;
  vehicle: { id: number; name: string; type: string; capacity: number };
  driver: StaffMember | null;
  stops: Stop[];
  pickLists?: { id: number; pickListNumber: string }[];
};

type UnassignedDelivery = {
  id: number;
  appointmentNumber: string;
  customer: {
    id: number;
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
  } | null;
  address: Address | null;
  deliveryZone: { id: number; name: string } | null;
  salesOrder: { id: number; orderno: string; lineItems: LineItem[] } | null;
};

const STATUS_ORDER = ["PLANNING", "LOADED", "IN_PROGRESS", "COMPLETED"] as const;
const STATUS_LABELS: Record<string, string> = {
  PLANNING: "Planning",
  LOADED: "Loaded",
  IN_PROGRESS: "In Progress",
  COMPLETED: "Completed",
};

export function RunDetailView({ id }: { id: string }) {
  const [run, setRun] = useState<DeliveryRun | null>(null);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddStop, setShowAddStop] = useState(false);
  const [unassigned, setUnassigned] = useState<UnassignedDelivery[]>([]);

  const fetchRun = useCallback(async () => {
    if (!id) return;
    try {
      const res = await axios.get(`/api/dispatch/runs/${encodeURIComponent(String(id))}`);
      setRun(res.data);
    } catch {
      toast.error("Failed to load run");
    } finally {
      setLoading(false);
    }
  }, [id]);

  const fetchStaff = useCallback(async () => {
    try {
      const res = await axios.get("/api/staff?role=WAREHOUSE&active=true");
      setStaff(res.data.staff || []);
    } catch {
      // Staff list is supplementary
    }
  }, []);

  useEffect(() => {
    fetchRun();
    fetchStaff();
  }, [fetchRun, fetchStaff]);

  async function fetchUnassigned() {
    try {
      const res = await axios.get("/api/dispatch/unassigned");
      const all = [
        ...(res.data.zones || []).flatMap(
          (z: { deliveries: UnassignedDelivery[] }) => z.deliveries,
        ),
        ...(res.data.unzoned || []),
      ];
      setUnassigned(all);
    } catch {
      toast.error("Failed to load unassigned deliveries");
    }
  }

  async function updateDriver(driverId: string) {
    if (!run) return;
    try {
      await axios.put(`/api/dispatch/runs/${run.id}`, {
        driverId: driverId || null,
      });
      fetchRun();
    } catch {
      toast.error("Failed to update driver");
    }
  }

  async function advanceStatus() {
    if (!run) return;
    const currentIdx = STATUS_ORDER.indexOf(run.status as (typeof STATUS_ORDER)[number]);
    if (currentIdx < 0 || currentIdx >= STATUS_ORDER.length - 1) return;

    const nextStatus = STATUS_ORDER[currentIdx + 1];
    try {
      await axios.put(`/api/dispatch/runs/${run.id}/status`, { status: nextStatus });
      toast.success(`Status updated to ${STATUS_LABELS[nextStatus]}`);
      fetchRun();
    } catch (err: unknown) {
      const msg =
        axios.isAxiosError(err) && err.response?.data?.error
          ? err.response.data.error
          : "Failed to update status";
      toast.error(msg);
    }
  }

  async function moveStop(stopIndex: number, direction: "up" | "down") {
    if (!run) return;
    const stops = [...run.stops];
    const swapIndex = direction === "up" ? stopIndex - 1 : stopIndex + 1;
    if (swapIndex < 0 || swapIndex >= stops.length) return;

    [stops[stopIndex], stops[swapIndex]] = [stops[swapIndex], stops[stopIndex]];
    const stopIds = stops.map((s) => s.id);

    try {
      await axios.put(`/api/dispatch/runs/${run.id}/stops`, { stopIds });
      fetchRun();
    } catch {
      toast.error("Failed to reorder stops");
    }
  }

  async function removeStop(stopId: number) {
    if (!run) return;
    try {
      await axios.delete(`/api/dispatch/runs/${run.id}/stops?stopId=${stopId}`);
      toast.success("Stop removed");
      fetchRun();
    } catch {
      toast.error("Failed to remove stop");
    }
  }

  async function addStop(appointmentId: number) {
    if (!run) return;
    try {
      await axios.post(`/api/dispatch/runs/${run.id}/stops`, {
        serviceAppointmentId: appointmentId,
      });
      toast.success("Stop added");
      setShowAddStop(false);
      fetchRun();
    } catch {
      toast.error("Failed to add stop");
    }
  }

  async function generatePickList() {
    if (!run) return;
    try {
      await axios.post("/api/dispatch/pick-lists", { deliveryRunId: run.id });
      toast.success("Pick list generated");
      fetchRun();
    } catch {
      toast.error("Failed to generate pick list");
    }
  }

  if (loading) {
    return <div className="text-center py-12 text-sh-gray">Loading...</div>;
  }

  if (!run) {
    return (
      <div className="text-center py-12">
        <p className="text-sh-gray mb-4">Delivery run not found</p>
        <Link href="/app/dispatch">
          <Button variant="outline">Back to Dispatch</Button>
        </Link>
      </div>
    );
  }

  const runDateFormatted = format(new Date(run.runDate), "EEEE, MMMM d, yyyy");
  const currentStatusIdx = STATUS_ORDER.indexOf(run.status as (typeof STATUS_ORDER)[number]);
  const canAdvance = currentStatusIdx >= 0 && currentStatusIdx < STATUS_ORDER.length - 1;
  const nextStatus = canAdvance ? STATUS_ORDER[currentStatusIdx + 1] : null;

  return (
    <>
      <div className="mb-4">
        <Link
          href="/app/dispatch"
          className="text-sm text-sh-blue hover:underline min-h-[44px] inline-flex items-center"
        >
          Back to Dispatch
        </Link>
      </div>

      {/* Header */}
      <div className="bg-white border border-sh-gray/10 rounded-lg p-4 mb-6">
        <div className="flex flex-wrap items-center justify-between gap-4 mb-3">
          <div>
            <h1 className="font-serif text-xl text-sh-navy">{run.runNumber}</h1>
            <p className="text-sm text-sh-gray">{runDateFormatted}</p>
          </div>
          <StatusBadge status={run.status} />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
          <div>
            <span className="text-sh-gray">Vehicle</span>
            <p className="font-semibold text-sh-navy">{run.vehicle.name}</p>
          </div>
          <div>
            <span className="text-sh-gray">Driver</span>
            <select
              value={run.driver?.id || ""}
              onChange={(e) => updateDriver(e.target.value)}
              className="block w-full mt-1 border border-sh-gray/30 rounded-lg px-3 py-2 text-sm min-h-[44px]"
            >
              <option value="">-- Select Driver --</option>
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.displayName}
                </option>
              ))}
            </select>
          </div>
          <div>
            <span className="text-sh-gray">Stops</span>
            <p className="font-semibold text-sh-navy">{run.stops.length}</p>
          </div>
        </div>

        {/* Status progression */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {STATUS_ORDER.map((s, idx) => (
            <div key={s} className="flex items-center gap-1">
              <span
                className={`text-xs px-2 py-1 rounded ${
                  s === run.status
                    ? "bg-sh-blue text-white font-semibold"
                    : idx < currentStatusIdx
                      ? "bg-sh-linen text-sh-navy"
                      : "bg-sh-stripe text-sh-gray"
                }`}
              >
                {STATUS_LABELS[s]}
              </span>
              {idx < STATUS_ORDER.length - 1 && (
                <span className="text-sh-gray/40 text-xs">&#8594;</span>
              )}
            </div>
          ))}
          {canAdvance && nextStatus && (
            <Button size="sm" onClick={advanceStatus} className="ml-2">
              Mark {STATUS_LABELS[nextStatus]}
            </Button>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-3 mb-6">
        <Button size="sm" variant="outline" onClick={generatePickList}>
          <FileText className="w-4 h-4 mr-1" />
          Generate Pick List
        </Button>
        {run.pickLists && run.pickLists.length > 0 && (
          <span className="text-sm text-sh-gray flex items-center">
            Pick list: {run.pickLists.map((pl) => pl.pickListNumber).join(", ")}
          </span>
        )}
      </div>

      {/* Stops */}
      <h2 className="font-serif text-lg text-sh-navy mb-3">Stops</h2>
      {run.stops.length === 0 ? (
        <div className="bg-white border border-sh-gray/10 rounded-lg p-6 text-center text-sh-gray text-sm mb-4">
          No stops on this run yet
        </div>
      ) : (
        <div className="space-y-3 mb-4">
          {run.stops.map((stop, idx) => {
            const appt = stop.serviceAppointment;
            const customerName = appt.customer
              ? `${appt.customer.firstName || ""} ${appt.customer.lastName || ""}`.trim()
              : "Unknown Customer";

            return (
              <div key={stop.id} className="bg-white border border-sh-gray/10 rounded-lg p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <span className="bg-sh-blue text-white text-sm font-semibold w-8 h-8 rounded-full flex items-center justify-center shrink-0">
                      {idx + 1}
                    </span>
                    <div>
                      <div className="font-semibold text-sh-navy">{customerName}</div>
                      {appt.address && (
                        <div className="text-sm text-sh-gray mt-0.5">
                          {appt.address.address1}, {appt.address.city}, {appt.address.state}{" "}
                          {appt.address.zip}
                        </div>
                      )}
                      {appt.customer?.phone && (
                        <a
                          href={`tel:${appt.customer.phone}`}
                          className="text-sm text-sh-blue mt-1 inline-flex items-center gap-1 min-h-[44px]"
                        >
                          <Phone className="w-3 h-3" />
                          {appt.customer.phone}
                        </a>
                      )}
                      {appt.salesOrder && appt.salesOrder.lineItems.length > 0 && (
                        <div className="mt-2 text-xs text-sh-gray">
                          {appt.salesOrder.lineItems.map((li) => (
                            <div key={li.id}>
                              {li.productName || "Unnamed item"} x{Number(li.orderedQuantity)}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <StopStatusBadge status={stop.status} />
                    <div className="flex items-center gap-1 mt-2">
                      <button
                        onClick={() => moveStop(idx, "up")}
                        disabled={idx === 0}
                        className="p-2 rounded hover:bg-sh-linen disabled:opacity-30 min-w-[44px] min-h-[44px] flex items-center justify-center"
                        aria-label="Move up"
                      >
                        <ArrowUp className="w-4 h-4 text-sh-gray" />
                      </button>
                      <button
                        onClick={() => moveStop(idx, "down")}
                        disabled={idx === run.stops.length - 1}
                        className="p-2 rounded hover:bg-sh-linen disabled:opacity-30 min-w-[44px] min-h-[44px] flex items-center justify-center"
                        aria-label="Move down"
                      >
                        <ArrowDown className="w-4 h-4 text-sh-gray" />
                      </button>
                      <button
                        onClick={() => removeStop(stop.id)}
                        className="p-2 rounded hover:bg-red-50 min-w-[44px] min-h-[44px] flex items-center justify-center"
                        aria-label="Remove stop"
                      >
                        <Trash2 className="w-4 h-4 text-red-500" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Button
        variant="outline"
        onClick={() => {
          setShowAddStop(true);
          fetchUnassigned();
        }}
      >
        <Plus className="w-4 h-4 mr-1" />
        Add Stop
      </Button>

      {/* Add Stop Modal */}
      {showAddStop && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-sh-black/40"
          role="presentation"
          onClick={() => setShowAddStop(false)}
          onKeyDown={(e) => e.key === "Escape" && setShowAddStop(false)}
        >
          <div
            className="bg-white rounded-lg shadow-lg w-full max-w-lg max-h-[80vh] overflow-y-auto m-4"
            role="presentation"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <div className="p-4 border-b border-sh-gray/10">
              <h3 className="font-serif text-lg text-sh-navy">Add Stop</h3>
            </div>
            <div className="p-4">
              {unassigned.length === 0 ? (
                <p className="text-sh-gray text-sm text-center py-4">
                  No unassigned deliveries available
                </p>
              ) : (
                <div className="space-y-2">
                  {unassigned.map((d) => {
                    const name = d.customer
                      ? `${d.customer.firstName || ""} ${d.customer.lastName || ""}`.trim()
                      : "Unknown Customer";
                    return (
                      <button
                        key={d.id}
                        onClick={() => addStop(d.id)}
                        className="w-full text-left p-3 rounded-lg border border-sh-gray/10 hover:bg-sh-linen transition min-h-[44px]"
                      >
                        <div className="font-semibold text-sh-navy text-sm">{name}</div>
                        <div className="text-xs text-sh-gray">
                          {d.address && `${d.address.city}, ${d.address.state}`}
                          {d.deliveryZone && (
                            <span className="ml-2 text-sh-gold">{d.deliveryZone.name}</span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="p-4 border-t border-sh-gray/10 flex justify-end">
              <Button variant="outline" onClick={() => setShowAddStop(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
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
      className={`text-xs px-2 py-1 rounded-full ${colors[status] || "bg-sh-linen text-sh-gray"}`}
    >
      {status.replace("_", " ")}
    </span>
  );
}

function StopStatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    PENDING: "bg-sh-stripe text-sh-gray",
    EN_ROUTE: "bg-sh-blue/10 text-sh-blue",
    ARRIVED: "bg-sh-gold/10 text-sh-gold",
    COMPLETED: "bg-green-50 text-green-700",
    FAILED: "bg-red-50 text-red-600",
  };

  return (
    <span
      className={`text-xs px-2 py-0.5 rounded-full ${colors[status] || "bg-sh-stripe text-sh-gray"}`}
    >
      {status.replace("_", " ")}
    </span>
  );
}
