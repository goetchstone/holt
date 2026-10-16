"use client";

// /app/src/app/(dashboard)/app/sales/returns/[id]/ReturnDetailView.tsx
//
// Return detail (summary, pickup, inspection, where the piece is, refund,
// exchange, vendor return, change history). Reads GET /api/returns/:id in the
// shared contract (lib/returns/returnDetailContract.ts), so a field the API
// renames is a compile error here instead of a crash on load. Putting the
// piece back or writing it off is the store's returned-stock queue
// (Warehouse > Returns), not this screen; the refund is RefundPanel.

import { useEffect, useState, useCallback } from "react";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { toast } from "react-toastify";
import { format } from "date-fns";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getErrorMessage } from "@/lib/toastError";
import type { ReturnDetail } from "@/lib/returns/returnDetailContract";
import { RefundPanel } from "./RefundPanel";

const STATUS_LABELS: Record<string, string> = {
  INITIATED: "Initiated",
  PICKUP_SCHEDULED: "Pickup Scheduled",
  PICKUP_COMPLETED: "Pickup Completed",
  RECEIVED: "Received",
  INSPECTED: "Inspected",
  RESTOCKED: "Restocked",
  WRITTEN_OFF: "Written Off",
  CLOSED: "Closed",
  CANCELLED: "Cancelled",
};

const STATUS_COLORS: Record<string, string> = {
  INITIATED: "bg-brand-gray/20 text-brand-gray",
  PICKUP_SCHEDULED: "bg-blue-100 text-blue-800",
  PICKUP_COMPLETED: "bg-blue-100 text-blue-800",
  RECEIVED: "bg-yellow-100 text-yellow-800",
  INSPECTED: "bg-orange-100 text-orange-800",
  RESTOCKED: "bg-green-100 text-green-800",
  WRITTEN_OFF: "bg-red-100 text-red-800",
  CLOSED: "bg-brand-gray/20 text-brand-gray",
  CANCELLED: "bg-red-100 text-red-800",
};

const REASON_LABELS: Record<string, string> = {
  DEFECTIVE: "Defective",
  DAMAGED_IN_DELIVERY: "Damaged in Delivery",
  WRONG_ITEM: "Wrong Item",
  CUSTOMER_CHANGED_MIND: "Customer Changed Mind",
  NOT_AS_DESCRIBED: "Not as Described",
  DUPLICATE_ORDER: "Duplicate Order",
  OTHER: "Other",
};

const CONDITION_LABELS: Record<string, string> = {
  LIKE_NEW: "Like New",
  MINOR_DAMAGE: "Minor Damage",
  MAJOR_DAMAGE: "Major Damage",
  UNSALVAGEABLE: "Unsalvageable",
};

const CONDITION_COLORS: Record<string, string> = {
  LIKE_NEW: "bg-green-100 text-green-800",
  MINOR_DAMAGE: "bg-yellow-100 text-yellow-800",
  MAJOR_DAMAGE: "bg-orange-100 text-orange-800",
  UNSALVAGEABLE: "bg-red-100 text-red-800",
};

const STATUS_ORDER = [
  "INITIATED",
  "PICKUP_SCHEDULED",
  "PICKUP_COMPLETED",
  "RECEIVED",
  "INSPECTED",
  "RESTOCKED",
  "WRITTEN_OFF",
  "CLOSED",
  "CANCELLED",
];

interface ChangeLogEntry {
  id: number;
  changeType: string;
  previousValue: string | null;
  newValue: string | null;
  reason: string | null;
  changedBy: string | null;
  created: string;
}

function isAtOrPastStatus(current: string, target: string): boolean {
  const currentIdx = STATUS_ORDER.indexOf(current);
  const targetIdx = STATUS_ORDER.indexOf(target);
  if (currentIdx === -1 || targetIdx === -1) return false;
  return currentIdx >= targetIdx;
}

export function ReturnDetailView({ id }: { id: string }) {
  const [returnData, setReturnData] = useState<ReturnDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [changeLog, setChangeLog] = useState<ChangeLogEntry[]>([]);

  // Inspection form state
  const [showInspectionForm, setShowInspectionForm] = useState(false);
  const [inspectionCondition, setInspectionCondition] = useState("");
  const [inspectionNotes, setInspectionNotes] = useState("");

  const fetchReturn = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const res = await axios.get<ReturnDetail>(`/api/returns/${encodeURIComponent(String(id))}`);
      setReturnData(res.data);
    } catch (err) {
      toast.error(getErrorMessage(err, "Could not load the return."));
    } finally {
      setLoading(false);
    }
  }, [id]);

  const orderId = returnData?.salesOrder.id;
  const fetchChangeLog = useCallback(async () => {
    if (!orderId) return;
    try {
      const res = await axios.get(`/api/sales/orders/${orderId}/changelog`);
      const entries = (res.data || []).filter((e: ChangeLogEntry) =>
        e.changeType.startsWith("RETURN_"),
      );
      setChangeLog(entries);
    } catch {
      // Non-critical, silently ignore
    }
  }, [orderId]);

  useEffect(() => {
    fetchReturn();
  }, [fetchReturn]);

  useEffect(() => {
    if (returnData) fetchChangeLog();
  }, [returnData, fetchChangeLog]);

  const updateStatus = async (newStatus: string, payload: Record<string, unknown> = {}) => {
    if (!id || updating) return;
    setUpdating(true);
    try {
      await axios.put(`/api/returns/${encodeURIComponent(String(id))}/status`, {
        status: newStatus,
        ...payload,
      });
      toast.success(`Status updated to ${STATUS_LABELS[newStatus]}`);
      fetchReturn();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Could not update the status."));
    } finally {
      setUpdating(false);
    }
  };

  const handleInspectionSubmit = () => {
    if (!inspectionCondition) {
      toast.error("Please select a condition.");
      return;
    }
    updateStatus("INSPECTED", {
      inspectionCondition,
      inspectionNotes: inspectionNotes || undefined,
    });
    setShowInspectionForm(false);
    setInspectionCondition("");
    setInspectionNotes("");
  };

  const handleCreateExchange = async () => {
    if (!id || updating) return;
    setUpdating(true);
    try {
      await axios.post(`/api/returns/${encodeURIComponent(String(id))}/exchange`);
      toast.success("Exchange order created.");
      fetchReturn();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Could not create the exchange."));
    } finally {
      setUpdating(false);
    }
  };

  if (loading && !returnData) {
    return <p className="text-brand-gray">Loading return details...</p>;
  }

  if (!returnData) {
    return <p className="text-brand-gray">Return not found.</p>;
  }

  const { pickup, inspection, disposition } = returnData;
  const showInspectionCard = isAtOrPastStatus(returnData.status, "RECEIVED");
  const showDispositionCard = disposition.receivedPlace != null;
  const showVendorCard =
    returnData.reason === "DEFECTIVE" || returnData.reason === "DAMAGED_IN_DELIVERY";

  return (
    <div className="max-w-4xl mx-auto mt-8 font-serif">
      {/* Header */}
      <div className="flex justify-between items-start mb-6">
        <div>
          <Link
            href="/app/sales/returns"
            className="inline-flex items-center text-sm text-brand-gray hover:text-brand-blue transition mb-2"
          >
            <ArrowLeft className="w-4 h-4 mr-1" />
            Back to Returns
          </Link>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-brand-blue">{returnData.returnNumber}</h1>
            <span
              className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[returnData.status] || "bg-gray-100 text-gray-800"}`}
            >
              {STATUS_LABELS[returnData.status] || returnData.status}
            </span>
          </div>
          <p className="text-sm text-brand-gray mt-1">
            Created {format(new Date(returnData.created), "PPP")}
          </p>
        </div>
      </div>

      {/* Summary Card */}
      <div className="bg-white p-6 rounded-lg shadow-md mb-6">
        <h2 className="text-xl font-semibold mb-3">Summary</h2>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div className="space-y-1.5">
            <p>
              <span className="font-medium text-brand-black">Order:</span>{" "}
              <Link
                href={`/app/sales/orders/${returnData.salesOrder.id}`}
                className="text-brand-blue hover:underline"
              >
                {returnData.salesOrder.orderno}
              </Link>
            </p>
            <p>
              <span className="font-medium text-brand-black">Customer:</span>{" "}
              {returnData.customer?.name || "N/A"}
            </p>
            <p>
              <span className="font-medium text-brand-black">Product:</span>{" "}
              {returnData.product?.name || "N/A"}
            </p>
            <p>
              <span className="font-medium text-brand-black">Part #:</span>{" "}
              {returnData.product?.productNumber || "N/A"}
            </p>
          </div>
          <div className="space-y-1.5">
            <p>
              <span className="font-medium text-brand-black">Quantity:</span> {returnData.quantity}
            </p>
            <p>
              <span className="font-medium text-brand-black">Reason:</span>{" "}
              {REASON_LABELS[returnData.reason] || returnData.reason}
            </p>
            {returnData.reasonNotes && (
              <p>
                <span className="font-medium text-brand-black">Notes:</span>{" "}
                {returnData.reasonNotes}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Pickup Card */}
      {pickup.required && (
        <div className="bg-white p-6 rounded-lg shadow-md mb-6">
          <h2 className="text-xl font-semibold mb-3">Pickup</h2>
          <div className="text-sm space-y-1.5">
            {pickup.address && (
              <p>
                <span className="font-medium text-brand-black">Address:</span> {pickup.address}
              </p>
            )}
            {pickup.date && (
              <p>
                <span className="font-medium text-brand-black">Date:</span>{" "}
                {format(new Date(pickup.date), "PPP")}
              </p>
            )}
            {pickup.timeSlot && (
              <p>
                <span className="font-medium text-brand-black">Time Slot:</span> {pickup.timeSlot}
              </p>
            )}
            {pickup.notes && (
              <p>
                <span className="font-medium text-brand-black">Notes:</span> {pickup.notes}
              </p>
            )}
          </div>
          {returnData.status === "INITIATED" && (
            <div className="mt-4">
              <Button
                size="sm"
                onClick={() => updateStatus("PICKUP_SCHEDULED")}
                disabled={updating}
              >
                {updating ? "Updating..." : "Schedule Pickup"}
              </Button>
            </div>
          )}
          {returnData.status === "PICKUP_SCHEDULED" && (
            <div className="mt-4">
              <Button
                size="sm"
                onClick={() => updateStatus("PICKUP_COMPLETED")}
                disabled={updating}
              >
                {updating ? "Updating..." : "Mark Picked Up"}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Inspection Card */}
      {showInspectionCard && (
        <div className="bg-white p-6 rounded-lg shadow-md mb-6">
          <h2 className="text-xl font-semibold mb-3">Inspection</h2>
          {inspection.condition && (
            <div className="text-sm space-y-1.5">
              <p>
                <span className="font-medium text-brand-black">Condition:</span>{" "}
                <span
                  className={`px-2 py-0.5 rounded-full text-xs font-medium ${CONDITION_COLORS[inspection.condition] || "bg-gray-100 text-gray-800"}`}
                >
                  {CONDITION_LABELS[inspection.condition] || inspection.condition}
                </span>
              </p>
              {inspection.notes && (
                <p>
                  <span className="font-medium text-brand-black">Notes:</span> {inspection.notes}
                </p>
              )}
              {inspection.inspectedBy && (
                <p>
                  <span className="font-medium text-brand-black">Inspected by:</span>{" "}
                  {inspection.inspectedBy}
                </p>
              )}
              {inspection.inspectedAt && (
                <p>
                  <span className="font-medium text-brand-black">Inspected at:</span>{" "}
                  {format(new Date(inspection.inspectedAt), "PPP p")}
                </p>
              )}
            </div>
          )}
          {!inspection.condition && returnData.status === "RECEIVED" && !showInspectionForm && (
            <Button size="sm" onClick={() => setShowInspectionForm(true)}>
              Record Inspection
            </Button>
          )}
          {!inspection.condition && returnData.status === "RECEIVED" && showInspectionForm && (
            <div className="space-y-3">
              <div>
                <label htmlFor="inspection-condition" className="block text-sm font-medium mb-1">
                  Condition
                </label>
                <select
                  id="inspection-condition"
                  value={inspectionCondition}
                  onChange={(e) => setInspectionCondition(e.target.value)}
                  className="w-full border border-brand-gray/30 rounded-lg px-3 py-2 text-sm"
                >
                  <option value="">Select condition...</option>
                  <option value="LIKE_NEW">Like New</option>
                  <option value="MINOR_DAMAGE">Minor Damage</option>
                  <option value="MAJOR_DAMAGE">Major Damage</option>
                  <option value="UNSALVAGEABLE">Unsalvageable</option>
                </select>
              </div>
              <div>
                <label htmlFor="inspection-notes" className="block text-sm font-medium mb-1">
                  Notes
                </label>
                <textarea
                  id="inspection-notes"
                  value={inspectionNotes}
                  onChange={(e) => setInspectionNotes(e.target.value)}
                  rows={3}
                  className="w-full border border-brand-gray/30 rounded-lg px-3 py-2 text-sm"
                  placeholder="Describe the item condition..."
                />
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={handleInspectionSubmit} disabled={updating}>
                  {updating ? "Saving..." : "Save Inspection"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setShowInspectionForm(false);
                    setInspectionCondition("");
                    setInspectionNotes("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
          {!inspection.condition && returnData.status !== "RECEIVED" && (
            <p className="text-sm text-brand-gray">No inspection recorded.</p>
          )}
          {returnData.status === "INSPECTED" && (
            <div className="mt-4">
              <Button
                size="sm"
                variant="outline"
                onClick={() => updateStatus("CLOSED")}
                disabled={updating}
              >
                {updating ? "Updating..." : "Close Return"}
              </Button>
              <p className="text-xs text-brand-gray mt-1">
                The customer&apos;s return can close now; the piece waits in the store&apos;s
                returned-stock queue until someone puts it back or writes it off.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Where the piece is */}
      {showDispositionCard && (
        <div className="bg-white p-6 rounded-lg shadow-md mb-6">
          <h2 className="text-xl font-semibold mb-3">The piece</h2>
          <div className="text-sm space-y-1.5">
            {disposition.restockedAt && (
              <p>
                <span className="font-medium text-brand-black">Put back at:</span>{" "}
                {disposition.restockedPlace ?? "—"} on{" "}
                {format(new Date(disposition.restockedAt), "PPP")}
              </p>
            )}
            {disposition.writtenOffAt && (
              <p>
                <span className="font-medium text-brand-black">Written off:</span>{" "}
                {format(new Date(disposition.writtenOffAt), "PPP")}
                {disposition.writeOffReason ? `, ${disposition.writeOffReason}` : ""}
              </p>
            )}
            {!disposition.restockedAt && !disposition.writtenOffAt && (
              <p>
                Waiting in <span className="font-medium">{disposition.receivedPlace}</span>.{" "}
                <Link href="/app/warehouse/returns" className="text-brand-blue hover:underline">
                  Put it back or write it off from Warehouse › Returns › Returned stock
                </Link>
                .
              </p>
            )}
          </div>
        </div>
      )}

      {/* Refund */}
      <RefundPanel returnId={returnData.id} detail={returnData} onChanged={fetchReturn} />

      {/* Exchange Card */}
      <div className="bg-white p-6 rounded-lg shadow-md mb-6">
        <h2 className="text-xl font-semibold mb-3">Exchange</h2>
        {returnData.exchangeOrder ? (
          <p className="text-sm">
            <span className="font-medium text-brand-black">Exchange Order:</span>{" "}
            <Link
              href={`/app/sales/orders/${returnData.exchangeOrder.id}`}
              className="text-brand-blue hover:underline"
            >
              {returnData.exchangeOrder.orderno}
            </Link>
          </p>
        ) : (
          <Button size="sm" onClick={handleCreateExchange} disabled={updating}>
            {updating ? "Creating..." : "Create Exchange"}
          </Button>
        )}
      </div>

      {/* Vendor Return Card */}
      {showVendorCard && (
        <div className="bg-white p-6 rounded-lg shadow-md mb-6">
          <h2 className="text-xl font-semibold mb-3">Vendor Return</h2>
          {returnData.vendorReturnPOs.length > 0 ? (
            <div className="text-sm space-y-1">
              {returnData.vendorReturnPOs.map((po) => (
                <p key={po.id}>
                  <span className="font-medium text-brand-black">PO:</span> {po.poNumber}
                </p>
              ))}
            </div>
          ) : (
            <div>
              <p className="text-sm text-brand-gray mb-3">
                No vendor return PO created yet. Create a negative PO to return this item to the
                vendor.
              </p>
              <Button size="sm" variant="outline" disabled>
                Return to Vendor
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Change History */}
      <div className="bg-white p-6 rounded-lg shadow-md mb-6">
        <h2 className="text-xl font-semibold mb-3">Change History</h2>
        {changeLog.length === 0 ? (
          <p className="text-sm text-brand-gray">No return-related changes recorded yet.</p>
        ) : (
          <div className="space-y-3">
            {changeLog.map((entry) => (
              <div
                key={entry.id}
                className="flex items-start gap-3 text-sm border-b border-brand-gray/10 pb-2 last:border-0"
              >
                <div className="w-2 h-2 rounded-full bg-brand-blue mt-1.5 shrink-0" />
                <div className="flex-1">
                  <p className="font-medium">{entry.changeType.replace(/_/g, " ")}</p>
                  {entry.previousValue && entry.newValue && (
                    <p className="text-brand-gray">
                      {entry.previousValue} &rarr; {entry.newValue}
                    </p>
                  )}
                  {!entry.previousValue && entry.newValue && (
                    <p className="text-brand-gray">{entry.newValue}</p>
                  )}
                  {entry.reason && <p className="text-brand-gray italic">{entry.reason}</p>}
                </div>
                <div className="text-xs text-brand-gray whitespace-nowrap">
                  <p>{format(new Date(entry.created), "MMM d, h:mm a")}</p>
                  {entry.changedBy && <p>{entry.changedBy.split("@")[0]}</p>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
