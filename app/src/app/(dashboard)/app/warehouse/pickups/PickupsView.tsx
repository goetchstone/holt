"use client";

// /app/src/app/(dashboard)/app/warehouse/pickups/PickupsView.tsx
//
// Pickup schedule body (pickups grouped by date, mark-complete action). App
// Router port of the legacy pages/warehouse/pickups.tsx body (minus MainLayout
// chrome, which comes from the (dashboard) layout). Reads the shared
// /api/warehouse/returns/pickups + /api/returns/[id]/status REST endpoints.
//
// A pickup can go on a delivery run as a stop (POST /api/dispatch/runs/[id]/
// stops with a returnId): the driver collects it, and completing the stop
// marks it picked up (lib/fulfilment/returnPickup.ts).

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import axios from "axios";
import { toast } from "react-toastify";
import { format } from "date-fns";
import { getErrorMessage } from "@/lib/toastError";

interface PickupAddress {
  address1: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

interface Pickup {
  id: number;
  returnNumber: string;
  status: string;
  orderno: string;
  customerName: string;
  customerPhone: string | null;
  productName: string | null;
  quantity: number;
  pickupDate: string | null;
  pickupTimeSlot: string | null;
  pickupNotes: string | null;
  address: PickupAddress | null;
  onRun: string | null;
}

interface OpenRun {
  id: number;
  runNumber: string;
  runDate: string;
}

interface DateGroup {
  label: string;
  sortKey: string;
  pickups: Pickup[];
  isUnscheduled: boolean;
}

function groupPickupsByDate(pickups: Pickup[]): DateGroup[] {
  const unscheduled: Pickup[] = [];
  const byDate: Record<string, Pickup[]> = {};

  for (const p of pickups) {
    if (!p.pickupDate) {
      unscheduled.push(p);
    } else {
      const dateKey = format(new Date(p.pickupDate), "yyyy-MM-dd");
      if (!byDate[dateKey]) byDate[dateKey] = [];
      byDate[dateKey].push(p);
    }
  }

  const groups: DateGroup[] = [];

  if (unscheduled.length > 0) {
    groups.push({
      label: "Unscheduled",
      sortKey: "0000-00-00",
      pickups: unscheduled,
      isUnscheduled: true,
    });
  }

  const sortedDates = Object.keys(byDate).sort((a, b) => a.localeCompare(b));
  for (const dateKey of sortedDates) {
    groups.push({
      label: format(new Date(dateKey + "T12:00:00"), "EEEE, MMMM d"),
      sortKey: dateKey,
      pickups: byDate[dateKey],
      isUnscheduled: false,
    });
  }

  return groups;
}

function formatAddress(addr: PickupAddress | null): string[] {
  if (!addr) return [];
  const lines: string[] = [];
  if (addr.address1) lines.push(addr.address1);
  if (addr.address2) lines.push(addr.address2);
  const cityLine = [addr.city, addr.state].filter(Boolean).join(", ");
  if (cityLine || addr.zip) {
    lines.push([cityLine, addr.zip].filter(Boolean).join(" "));
  }
  return lines;
}

export function PickupsView() {
  const [pickups, setPickups] = useState<Pickup[]>([]);
  const [loading, setLoading] = useState(true);
  const [completing, setCompleting] = useState<number | null>(null);
  const [runs, setRuns] = useState<OpenRun[]>([]);

  const loadData = async () => {
    setLoading(true);
    try {
      const res = await axios.get("/api/warehouse/returns/pickups");
      setPickups(res.data.pickups);
    } catch {
      setPickups([]);
    } finally {
      setLoading(false);
    }
    // Runs a pickup can join. Someone who cannot see runs just does not get
    // the choice.
    try {
      const lists = await Promise.all(
        ["PLANNING", "LOADED"].map((s) => axios.get(`/api/dispatch/runs?status=${s}`)),
      );
      setRuns(lists.flatMap((r) => (r.data.runs ?? []) as OpenRun[]));
    } catch {
      setRuns([]);
    }
  };

  const handleAddToRun = async (id: number, runId: number) => {
    setCompleting(id);
    try {
      await axios.post(`/api/dispatch/runs/${runId}/stops`, { returnId: id });
      toast.success("Added to the run");
      await loadData();
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, "Failed to add the pickup to the run"));
    } finally {
      setCompleting(null);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleComplete = async (id: number) => {
    setCompleting(id);
    try {
      await axios.put(`/api/returns/${id}/status`, { status: "PICKUP_COMPLETED" });
      await axios.put(`/api/returns/${id}/status`, { status: "RECEIVED" });
      toast.success("Pickup marked complete");
      await loadData();
    } catch (error: unknown) {
      const message =
        axios.isAxiosError(error) && error.response?.data?.error
          ? error.response.data.error
          : "Failed to update pickup status";
      toast.error(message);
    } finally {
      setCompleting(null);
    }
  };

  const groups = groupPickupsByDate(pickups);

  return (
    <div className="py-2 space-y-6 font-serif">
      <h1 className="text-2xl text-brand-blue font-semibold">Pickup Schedule</h1>

      {loading ? (
        <p className="text-brand-gray">Loading...</p>
      ) : groups.length === 0 ? (
        <p className="text-brand-gray py-8 text-center">No pickups scheduled</p>
      ) : (
        groups.map((group) => (
          <div key={group.sortKey} className="space-y-3">
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-semibold text-brand-black">{group.label}</h2>
              {group.isUnscheduled && (
                <span className="text-xs px-2 py-0.5 rounded bg-yellow-100 text-yellow-800">
                  Needs scheduling
                </span>
              )}
            </div>

            <div className="grid gap-3">
              {group.pickups.map((p) => (
                <PickupCard
                  key={p.id}
                  pickup={p}
                  completing={completing === p.id}
                  onComplete={() => handleComplete(p.id)}
                  runs={runs}
                  onAddToRun={(runId) => handleAddToRun(p.id, runId)}
                />
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function PickupCard({
  pickup,
  completing,
  onComplete,
  runs,
  onAddToRun,
}: {
  pickup: Pickup;
  completing: boolean;
  onComplete: () => void;
  runs: OpenRun[];
  onAddToRun: (runId: number) => void;
}) {
  const addressLines = formatAddress(pickup.address);
  const [runId, setRunId] = useState<number | "">("");

  return (
    <div className="bg-white rounded-lg border border-brand-gray/20 shadow-md p-5">
      <div className="flex justify-between items-start gap-4">
        <div className="flex-1 space-y-2">
          <div className="flex items-center gap-3">
            <span className="text-lg font-semibold text-brand-black">{pickup.customerName}</span>
            {pickup.pickupTimeSlot && (
              <span className="text-xs px-2 py-0.5 rounded bg-brand-blue/10 text-brand-blue font-medium">
                {pickup.pickupTimeSlot}
              </span>
            )}
          </div>

          <p className="text-sm text-brand-gray">{pickup.productName || "Unknown product"}</p>

          {addressLines.length > 0 && (
            <div className="text-sm text-brand-gray leading-relaxed">
              {addressLines.map((line, i) => (
                <div key={i}>{line}</div>
              ))}
            </div>
          )}

          {pickup.customerPhone && (
            <p className="text-sm text-brand-gray">
              <a href={`tel:${pickup.customerPhone}`} className="underline">
                {pickup.customerPhone}
              </a>
            </p>
          )}

          {pickup.pickupNotes && (
            <p className="text-sm text-brand-gray italic border-l-2 border-brand-gold pl-3 mt-1">
              {pickup.pickupNotes}
            </p>
          )}

          <div className="flex gap-4 text-xs text-brand-gray/70 pt-1">
            <span>{pickup.returnNumber}</span>
            <span>Order {pickup.orderno}</span>
            {pickup.quantity > 1 && <span>Qty: {pickup.quantity}</span>}
          </div>
        </div>

        <div className="flex flex-col items-end gap-2">
          <Button
            className="min-h-[44px] min-w-[120px] text-base"
            disabled={completing}
            onClick={onComplete}
          >
            {completing ? "Updating..." : "Mark Complete"}
          </Button>
          {pickup.onRun && (
            <span className="text-xs px-2 py-0.5 rounded bg-brand-blue/10 text-brand-blue">
              On run {pickup.onRun}
            </span>
          )}
          {!pickup.onRun && runs.length > 0 && (
            <div className="flex items-center gap-2">
              <select
                aria-label={`Run for ${pickup.returnNumber}`}
                value={runId}
                onChange={(e) => setRunId(e.target.value ? Number(e.target.value) : "")}
                className="min-h-[44px] rounded border border-brand-gray/30 px-2 text-sm"
              >
                <option value="">Choose a run</option>
                {runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.runNumber} ({format(new Date(r.runDate), "MMM d")})
                  </option>
                ))}
              </select>
              <Button
                variant="outline"
                className="min-h-[44px]"
                disabled={completing || runId === ""}
                onClick={() => runId !== "" && onAddToRun(runId)}
              >
                Add to run
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
