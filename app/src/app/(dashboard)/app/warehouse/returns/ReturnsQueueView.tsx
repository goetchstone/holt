"use client";

// /app/src/app/(dashboard)/app/warehouse/returns/ReturnsQueueView.tsx
//
// Returns queue body (pickup / inspection / decision tabs + status actions). App
// Router port of the legacy pages/warehouse/returns.tsx body (minus MainLayout
// chrome, which comes from the (dashboard) layout). Reads the shared
// /api/warehouse/returns/queue + /api/returns/[id]/status REST endpoints.

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import axios from "axios";
import { toast } from "react-toastify";
import { format } from "date-fns";

interface QueueReturn {
  id: number;
  returnNumber: string;
  status: string;
  reason: string;
  orderno: string;
  customerName: string;
  productName: string | null;
  quantity: number;
  pickupRequired: boolean;
  pickupDate: string | null;
  inspectionCondition: string | null;
  inspectionNotes: string | null;
  receivedLocationName: string | null;
  created: string;
}

type Tab = "pickup" | "inspection" | "decision";

const STATUS_LABELS: Record<string, string> = {
  INITIATED: "Initiated",
  PICKUP_SCHEDULED: "Pickup Scheduled",
  PICKUP_COMPLETED: "Pickup Completed",
  RECEIVED: "Received",
  INSPECTED: "Inspected",
  RESTOCKED: "Restocked",
  WRITTEN_OFF: "Written Off",
  CANCELLED: "Cancelled",
};

const STATUS_STYLES: Record<string, string> = {
  INITIATED: "bg-sh-gray/20 text-sh-gray",
  PICKUP_SCHEDULED: "bg-blue-100 text-blue-800",
  PICKUP_COMPLETED: "bg-blue-100 text-blue-800",
  RECEIVED: "bg-yellow-100 text-yellow-800",
  INSPECTED: "bg-orange-100 text-orange-800",
  RESTOCKED: "bg-green-100 text-green-800",
  WRITTEN_OFF: "bg-red-100 text-red-800",
  CANCELLED: "bg-red-100 text-red-800",
};

const CONDITION_LABELS: Record<string, string> = {
  LIKE_NEW: "Like New",
  MINOR_DAMAGE: "Minor Damage",
  MAJOR_DAMAGE: "Major Damage",
  UNSALVAGEABLE: "Unsalvageable",
};

const CONDITION_STYLES: Record<string, string> = {
  LIKE_NEW: "bg-green-100 text-green-800",
  MINOR_DAMAGE: "bg-yellow-100 text-yellow-800",
  MAJOR_DAMAGE: "bg-orange-100 text-orange-800",
  UNSALVAGEABLE: "bg-red-100 text-red-800",
};

export function ReturnsQueueView() {
  const [tab, setTab] = useState<Tab>("pickup");
  const [returns, setReturns] = useState<Record<Tab, QueueReturn[]>>({
    pickup: [],
    inspection: [],
    decision: [],
  });
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [inspectionForm, setInspectionForm] = useState<{
    condition: string;
    notes: string;
  }>({ condition: "", notes: "" });
  const [submitting, setSubmitting] = useState(false);

  const loadData = async () => {
    setLoading(true);
    try {
      const [pickupRes, inspectionRes, decisionRes] = await Promise.all([
        axios.get("/api/warehouse/returns/queue?tab=pickup"),
        axios.get("/api/warehouse/returns/queue?tab=inspection"),
        axios.get("/api/warehouse/returns/queue?tab=decision"),
      ]);
      setReturns({
        pickup: pickupRes.data.returns,
        inspection: inspectionRes.data.returns,
        decision: decisionRes.data.returns,
      });
    } catch {
      setReturns({ pickup: [], inspection: [], decision: [] });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const updateStatus = async (id: number, status: string, fields?: Record<string, unknown>) => {
    setSubmitting(true);
    try {
      await axios.put(`/api/returns/${id}/status`, { status, ...fields });
      toast.success(`Return updated to ${STATUS_LABELS[status] || status}`);
      setExpandedId(null);
      setInspectionForm({ condition: "", notes: "" });
      await loadData();
    } catch (error: unknown) {
      const message =
        axios.isAxiosError(error) && error.response?.data?.error
          ? error.response.data.error
          : "Failed to update status";
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSchedule = async (id: number) => {
    await updateStatus(id, "PICKUP_SCHEDULED");
  };

  const handlePickedUp = async (id: number) => {
    setSubmitting(true);
    try {
      await axios.put(`/api/returns/${id}/status`, { status: "PICKUP_COMPLETED" });
      await axios.put(`/api/returns/${id}/status`, { status: "RECEIVED" });
      toast.success("Return marked as picked up and received");
      await loadData();
    } catch (error: unknown) {
      const message =
        axios.isAxiosError(error) && error.response?.data?.error
          ? error.response.data.error
          : "Failed to update status";
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleInspect = async (id: number) => {
    if (!inspectionForm.condition) {
      toast.error("Please select a condition");
      return;
    }
    await updateStatus(id, "INSPECTED", {
      inspectionCondition: inspectionForm.condition,
      inspectionNotes: inspectionForm.notes || undefined,
    });
  };

  const tabs: { key: Tab; label: string }[] = [
    { key: "pickup", label: "Pending Pickup" },
    { key: "inspection", label: "Awaiting Inspection" },
    { key: "decision", label: "Needs Decision" },
  ];

  return (
    <div className="py-2 space-y-4 font-serif">
      <h1 className="text-2xl text-sh-blue font-semibold">Returns Queue</h1>

      <div className="flex gap-1 border-b border-sh-gray/20">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium transition border-b-2 -mb-px ${
              tab === t.key
                ? "border-sh-blue text-sh-blue"
                : "border-transparent text-sh-gray hover:text-sh-black"
            }`}
          >
            {t.label} ({returns[t.key].length})
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-sh-gray">Loading...</p>
      ) : tab === "pickup" ? (
        <PickupTable
          returns={returns.pickup}
          submitting={submitting}
          onSchedule={handleSchedule}
          onPickedUp={handlePickedUp}
        />
      ) : tab === "inspection" ? (
        <InspectionTable
          returns={returns.inspection}
          expandedId={expandedId}
          inspectionForm={inspectionForm}
          submitting={submitting}
          onToggleExpand={(id) => {
            if (expandedId === id) {
              setExpandedId(null);
              setInspectionForm({ condition: "", notes: "" });
            } else {
              setExpandedId(id);
              setInspectionForm({ condition: "", notes: "" });
            }
          }}
          onFormChange={setInspectionForm}
          onSubmit={handleInspect}
        />
      ) : (
        <DecisionTable
          returns={returns.decision}
          submitting={submitting}
          onRestock={(id) => updateStatus(id, "RESTOCKED")}
          onWriteOff={(id) => updateStatus(id, "WRITTEN_OFF")}
        />
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`text-xs px-2 py-0.5 rounded ${STATUS_STYLES[status] || "bg-sh-gray/20 text-sh-gray"}`}
    >
      {STATUS_LABELS[status] || status}
    </span>
  );
}

function ConditionBadge({ condition }: { condition: string }) {
  return (
    <span
      className={`text-xs px-2 py-0.5 rounded ${CONDITION_STYLES[condition] || "bg-sh-gray/20 text-sh-gray"}`}
    >
      {CONDITION_LABELS[condition] || condition}
    </span>
  );
}

function EmptyRow({ colSpan, message }: { colSpan: number; message: string }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-8 text-center text-sh-gray">
        {message}
      </td>
    </tr>
  );
}

function PickupTable({
  returns,
  submitting,
  onSchedule,
  onPickedUp,
}: {
  returns: QueueReturn[];
  submitting: boolean;
  onSchedule: (id: number) => void;
  onPickedUp: (id: number) => void;
}) {
  return (
    <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-sh-gray/20 bg-sh-stripe">
            <th className="text-left px-4 py-3 font-medium text-sh-gray">Return #</th>
            <th className="text-left px-4 py-3 font-medium text-sh-gray">Order #</th>
            <th className="text-left px-4 py-3 font-medium text-sh-gray">Customer</th>
            <th className="text-left px-4 py-3 font-medium text-sh-gray">Product</th>
            <th className="text-left px-4 py-3 font-medium text-sh-gray w-[100px]">Pickup Date</th>
            <th className="text-left px-4 py-3 font-medium text-sh-gray w-[120px]">Status</th>
            <th className="text-right px-4 py-3 font-medium text-sh-gray w-[160px]">Actions</th>
          </tr>
        </thead>
        <tbody>
          {returns.length === 0 ? (
            <EmptyRow colSpan={7} message="No returns pending pickup" />
          ) : (
            returns.map((r) => (
              <tr key={r.id} className="border-b border-sh-gray/10 hover:bg-sh-stripe/50">
                <td className="px-4 py-2 text-sh-black font-medium">{r.returnNumber}</td>
                <td className="px-4 py-2 text-sh-gray">{r.orderno}</td>
                <td className="px-4 py-2 text-sh-gray">{r.customerName}</td>
                <td className="px-4 py-2 text-sh-gray">{r.productName || "--"}</td>
                <td className="px-4 py-2 text-sh-gray text-xs">
                  {r.pickupDate ? format(new Date(r.pickupDate), "MMM d") : "--"}
                </td>
                <td className="px-4 py-2">
                  <StatusBadge status={r.status} />
                </td>
                <td className="px-4 py-2 text-right">
                  <div className="flex gap-1 justify-end">
                    {r.status === "INITIATED" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={submitting}
                        onClick={() => onSchedule(r.id)}
                      >
                        Schedule
                      </Button>
                    )}
                    {r.status === "PICKUP_SCHEDULED" && (
                      <Button size="sm" disabled={submitting} onClick={() => onPickedUp(r.id)}>
                        Picked Up
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function InspectionTable({
  returns,
  expandedId,
  inspectionForm,
  submitting,
  onToggleExpand,
  onFormChange,
  onSubmit,
}: {
  returns: QueueReturn[];
  expandedId: number | null;
  inspectionForm: { condition: string; notes: string };
  submitting: boolean;
  onToggleExpand: (id: number) => void;
  onFormChange: (form: { condition: string; notes: string }) => void;
  onSubmit: (id: number) => void;
}) {
  return (
    <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-sh-gray/20 bg-sh-stripe">
            <th className="text-left px-4 py-3 font-medium text-sh-gray">Return #</th>
            <th className="text-left px-4 py-3 font-medium text-sh-gray">Order #</th>
            <th className="text-left px-4 py-3 font-medium text-sh-gray">Customer</th>
            <th className="text-left px-4 py-3 font-medium text-sh-gray">Product</th>
            <th className="text-left px-4 py-3 font-medium text-sh-gray w-[120px]">Location</th>
            <th className="text-right px-4 py-3 font-medium text-sh-gray w-[100px]">Actions</th>
          </tr>
        </thead>
        <tbody>
          {returns.length === 0 ? (
            <EmptyRow colSpan={6} message="No returns awaiting inspection" />
          ) : (
            returns.map((r) => (
              <>
                <tr key={r.id} className="border-b border-sh-gray/10 hover:bg-sh-stripe/50">
                  <td className="px-4 py-2 text-sh-black font-medium">{r.returnNumber}</td>
                  <td className="px-4 py-2 text-sh-gray">{r.orderno}</td>
                  <td className="px-4 py-2 text-sh-gray">{r.customerName}</td>
                  <td className="px-4 py-2 text-sh-gray">{r.productName || "--"}</td>
                  <td className="px-4 py-2 text-sh-gray text-xs">
                    {r.receivedLocationName || "--"}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Button
                      size="sm"
                      variant={expandedId === r.id ? "secondary" : "outline"}
                      onClick={() => onToggleExpand(r.id)}
                    >
                      {expandedId === r.id ? "Cancel" : "Inspect"}
                    </Button>
                  </td>
                </tr>
                {expandedId === r.id && (
                  <tr key={`${r.id}-form`} className="border-b border-sh-gray/10 bg-sh-linen">
                    <td colSpan={6} className="px-4 py-4">
                      <div className="flex flex-wrap items-end gap-4">
                        <div>
                          <label className="block text-xs font-medium text-sh-gray mb-1">
                            Condition
                          </label>
                          <select
                            className="border border-sh-gray/30 rounded px-3 py-2 text-sm min-w-[180px]"
                            value={inspectionForm.condition}
                            onChange={(e) =>
                              onFormChange({ ...inspectionForm, condition: e.target.value })
                            }
                          >
                            <option value="">Select condition...</option>
                            <option value="LIKE_NEW">Like New</option>
                            <option value="MINOR_DAMAGE">Minor Damage</option>
                            <option value="MAJOR_DAMAGE">Major Damage</option>
                            <option value="UNSALVAGEABLE">Unsalvageable</option>
                          </select>
                        </div>
                        <div className="flex-1 min-w-[200px]">
                          <label className="block text-xs font-medium text-sh-gray mb-1">
                            Notes
                          </label>
                          <textarea
                            className="border border-sh-gray/30 rounded px-3 py-2 text-sm w-full"
                            rows={2}
                            placeholder="Inspection notes..."
                            value={inspectionForm.notes}
                            onChange={(e) =>
                              onFormChange({ ...inspectionForm, notes: e.target.value })
                            }
                          />
                        </div>
                        <Button disabled={submitting} onClick={() => onSubmit(r.id)}>
                          Submit Inspection
                        </Button>
                      </div>
                    </td>
                  </tr>
                )}
              </>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function DecisionTable({
  returns,
  submitting,
  onRestock,
  onWriteOff,
}: {
  returns: QueueReturn[];
  submitting: boolean;
  onRestock: (id: number) => void;
  onWriteOff: (id: number) => void;
}) {
  return (
    <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-sh-gray/20 bg-sh-stripe">
            <th className="text-left px-4 py-3 font-medium text-sh-gray">Return #</th>
            <th className="text-left px-4 py-3 font-medium text-sh-gray">Customer</th>
            <th className="text-left px-4 py-3 font-medium text-sh-gray">Product</th>
            <th className="text-left px-4 py-3 font-medium text-sh-gray w-[120px]">Condition</th>
            <th className="text-left px-4 py-3 font-medium text-sh-gray">Notes</th>
            <th className="text-right px-4 py-3 font-medium text-sh-gray w-[200px]">Actions</th>
          </tr>
        </thead>
        <tbody>
          {returns.length === 0 ? (
            <EmptyRow colSpan={6} message="No returns needing a decision" />
          ) : (
            returns.map((r) => (
              <tr key={r.id} className="border-b border-sh-gray/10 hover:bg-sh-stripe/50">
                <td className="px-4 py-2 text-sh-black font-medium">{r.returnNumber}</td>
                <td className="px-4 py-2 text-sh-gray">{r.customerName}</td>
                <td className="px-4 py-2 text-sh-gray">{r.productName || "--"}</td>
                <td className="px-4 py-2">
                  {r.inspectionCondition ? (
                    <ConditionBadge condition={r.inspectionCondition} />
                  ) : (
                    "--"
                  )}
                </td>
                <td className="px-4 py-2 text-sh-gray text-xs">{r.inspectionNotes || "--"}</td>
                <td className="px-4 py-2 text-right">
                  <div className="flex gap-1 justify-end">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={submitting}
                      onClick={() => onRestock(r.id)}
                    >
                      Restock
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={submitting}
                      className="text-red-700 border-red-300 hover:bg-red-50"
                      onClick={() => onWriteOff(r.id)}
                    >
                      Write Off
                    </Button>
                  </div>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
