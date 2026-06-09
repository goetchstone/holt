"use client";

// /app/src/app/(dashboard)/app/sales/returns/[id]/ReturnDetailView.tsx
//
// Return detail (summary, pickup, inspection, disposition, refund, exchange,
// vendor return, change history). App Router port of the legacy
// sales/returns/[id] body (minus MainLayout chrome, which the (dashboard) layout
// supplies). Reads + writes the shared REST endpoints (/api/returns/:id[/status
// /refund /exchange], /api/sales/orders/:id/changelog), which stay REST. The id
// arrives as a prop from the server page (params awaited there).

import { useEffect, useState, useCallback } from "react";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { toast } from "react-toastify";
import { format } from "date-fns";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";

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
  INITIATED: "bg-sh-gray/20 text-sh-gray",
  PICKUP_SCHEDULED: "bg-blue-100 text-blue-800",
  PICKUP_COMPLETED: "bg-blue-100 text-blue-800",
  RECEIVED: "bg-yellow-100 text-yellow-800",
  INSPECTED: "bg-orange-100 text-orange-800",
  RESTOCKED: "bg-green-100 text-green-800",
  WRITTEN_OFF: "bg-red-100 text-red-800",
  CLOSED: "bg-sh-gray/20 text-sh-gray",
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

interface ReturnDetail {
  id: number;
  returnNumber: string;
  status: string;
  reason: string;
  reasonNotes: string | null;
  quantity: number;
  pickupRequired: boolean;
  pickupAddress: string | null;
  pickupDate: string | null;
  pickupTimeSlot: string | null;
  pickupNotes: string | null;
  inspectionCondition: string | null;
  inspectionNotes: string | null;
  inspectedBy: string | null;
  inspectedAt: string | null;
  restockedLocation: string | null;
  writeOffReason: string | null;
  refundAmount: number | null;
  refundPaymentId: number | null;
  refundPaymentType: string | null;
  exchangeOrderId: number | null;
  exchangeOrderNo: string | null;
  createdAt: string;
  order: {
    id: number;
    orderno: string;
  };
  customer: {
    firstName: string;
    lastName: string;
  } | null;
  product: {
    name: string;
    productNumber: string | null;
  } | null;
  vendorReturnPOs: {
    id: number;
    poNumber: string;
  }[];
  payments: {
    id: number;
    paymentType: string;
    paymentAmount: number;
  }[];
}

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
  const formatCurrency = useMoneyFormatter();
  const [returnData, setReturnData] = useState<ReturnDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [changeLog, setChangeLog] = useState<ChangeLogEntry[]>([]);

  // Inspection form state
  const [showInspectionForm, setShowInspectionForm] = useState(false);
  const [inspectionCondition, setInspectionCondition] = useState("");
  const [inspectionNotes, setInspectionNotes] = useState("");

  // Disposition state
  const [showRestockForm, setShowRestockForm] = useState(false);
  const [restockLocation, setRestockLocation] = useState("");
  const [showWriteOffForm, setShowWriteOffForm] = useState(false);
  const [writeOffReason, setWriteOffReason] = useState("");

  // Refund form state
  const [showRefundForm, setShowRefundForm] = useState(false);
  const [refundPaymentId, setRefundPaymentId] = useState<number | "">("");
  const [refundAmount, setRefundAmount] = useState("");

  const fetchReturn = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const res = await axios.get(`/api/returns/${encodeURIComponent(String(id))}`);
      setReturnData(res.data);
    } catch {
      toast.error("Failed to load return details.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  const fetchChangeLog = useCallback(async () => {
    if (!returnData?.order?.id) return;
    try {
      const res = await axios.get(`/api/sales/orders/${returnData.order.id}/changelog`);
      const entries = (res.data || []).filter((e: ChangeLogEntry) =>
        e.changeType.startsWith("RETURN_"),
      );
      setChangeLog(entries);
    } catch {
      // Non-critical, silently ignore
    }
  }, [returnData?.order?.id]);

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
      const message =
        axios.isAxiosError(err) && err.response?.data?.error
          ? err.response.data.error
          : "Failed to update status";
      toast.error(message);
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

  const handleRestock = () => {
    if (!restockLocation.trim()) {
      toast.error("Please enter a restock location.");
      return;
    }
    updateStatus("RESTOCKED", { restockedLocation: restockLocation });
    setShowRestockForm(false);
    setRestockLocation("");
  };

  const handleWriteOff = () => {
    if (!writeOffReason.trim()) {
      toast.error("Please enter a write-off reason.");
      return;
    }
    updateStatus("WRITTEN_OFF", { writeOffReason });
    setShowWriteOffForm(false);
    setWriteOffReason("");
  };

  const handleIssueRefund = async () => {
    if (!id || !refundPaymentId || !refundAmount) {
      toast.error("Please select a payment and enter an amount.");
      return;
    }
    setUpdating(true);
    try {
      await axios.post(`/api/returns/${encodeURIComponent(String(id))}/refund`, {
        paymentId: refundPaymentId,
        amount: Number.parseFloat(refundAmount),
      });
      toast.success("Refund issued.");
      fetchReturn();
      setShowRefundForm(false);
      setRefundPaymentId("");
      setRefundAmount("");
    } catch (err: unknown) {
      const message =
        axios.isAxiosError(err) && err.response?.data?.error
          ? err.response.data.error
          : "Failed to issue refund";
      toast.error(message);
    } finally {
      setUpdating(false);
    }
  };

  const handleCreateExchange = async () => {
    if (!id || updating) return;
    setUpdating(true);
    try {
      const res = await axios.post(`/api/returns/${encodeURIComponent(String(id))}/exchange`);
      toast.success("Exchange order created.");
      if (res.data.exchangeOrderId) {
        fetchReturn();
      }
    } catch (err: unknown) {
      const message =
        axios.isAxiosError(err) && err.response?.data?.error
          ? err.response.data.error
          : "Failed to create exchange";
      toast.error(message);
    } finally {
      setUpdating(false);
    }
  };

  if (loading) {
    return <p className="text-sh-gray">Loading return details...</p>;
  }

  if (!returnData) {
    return <p className="text-sh-gray">Return not found.</p>;
  }

  const showPickupCard = returnData.pickupRequired;
  const showInspectionCard = isAtOrPastStatus(returnData.status, "RECEIVED");
  const showDispositionCard = isAtOrPastStatus(returnData.status, "INSPECTED");
  const showVendorCard =
    returnData.reason === "DEFECTIVE" || returnData.reason === "DAMAGED_IN_DELIVERY";

  return (
    <div className="max-w-4xl mx-auto mt-8 font-serif">
      {/* Header */}
      <div className="flex justify-between items-start mb-6">
        <div>
          <Link
            href="/app/sales/returns"
            className="inline-flex items-center text-sm text-sh-gray hover:text-sh-blue transition mb-2"
          >
            <ArrowLeft className="w-4 h-4 mr-1" />
            Back to Returns
          </Link>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-sh-blue">{returnData.returnNumber}</h1>
            <span
              className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[returnData.status] || "bg-gray-100 text-gray-800"}`}
            >
              {STATUS_LABELS[returnData.status] || returnData.status}
            </span>
          </div>
          <p className="text-sm text-sh-gray mt-1">
            Created {format(new Date(returnData.createdAt), "PPP")}
          </p>
        </div>
      </div>

      {/* Summary Card */}
      <div className="bg-white p-6 rounded-lg shadow-md mb-6">
        <h2 className="text-xl font-semibold mb-3">Summary</h2>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div className="space-y-1.5">
            <p>
              <span className="font-medium text-sh-black">Order:</span>{" "}
              <Link
                href={`/app/sales/orders/${returnData.order.id}`}
                className="text-sh-blue hover:underline"
              >
                {returnData.order.orderno}
              </Link>
            </p>
            <p>
              <span className="font-medium text-sh-black">Customer:</span>{" "}
              {returnData.customer
                ? `${returnData.customer.firstName} ${returnData.customer.lastName}`
                : "N/A"}
            </p>
            <p>
              <span className="font-medium text-sh-black">Product:</span>{" "}
              {returnData.product?.name || "N/A"}
            </p>
            <p>
              <span className="font-medium text-sh-black">Part #:</span>{" "}
              {returnData.product?.productNumber || "N/A"}
            </p>
          </div>
          <div className="space-y-1.5">
            <p>
              <span className="font-medium text-sh-black">Quantity:</span> {returnData.quantity}
            </p>
            <p>
              <span className="font-medium text-sh-black">Reason:</span>{" "}
              {REASON_LABELS[returnData.reason] || returnData.reason}
            </p>
            {returnData.reasonNotes && (
              <p>
                <span className="font-medium text-sh-black">Notes:</span> {returnData.reasonNotes}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Pickup Card */}
      {showPickupCard && (
        <div className="bg-white p-6 rounded-lg shadow-md mb-6">
          <h2 className="text-xl font-semibold mb-3">Pickup</h2>
          <div className="text-sm space-y-1.5">
            {returnData.pickupAddress && (
              <p>
                <span className="font-medium text-sh-black">Address:</span>{" "}
                {returnData.pickupAddress}
              </p>
            )}
            {returnData.pickupDate && (
              <p>
                <span className="font-medium text-sh-black">Date:</span>{" "}
                {format(new Date(returnData.pickupDate), "PPP")}
              </p>
            )}
            {returnData.pickupTimeSlot && (
              <p>
                <span className="font-medium text-sh-black">Time Slot:</span>{" "}
                {returnData.pickupTimeSlot}
              </p>
            )}
            {returnData.pickupNotes && (
              <p>
                <span className="font-medium text-sh-black">Notes:</span> {returnData.pickupNotes}
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
          {returnData.inspectionCondition ? (
            <div className="text-sm space-y-1.5">
              <p>
                <span className="font-medium text-sh-black">Condition:</span>{" "}
                <span
                  className={`px-2 py-0.5 rounded-full text-xs font-medium ${CONDITION_COLORS[returnData.inspectionCondition] || "bg-gray-100 text-gray-800"}`}
                >
                  {CONDITION_LABELS[returnData.inspectionCondition] ||
                    returnData.inspectionCondition}
                </span>
              </p>
              {returnData.inspectionNotes && (
                <p>
                  <span className="font-medium text-sh-black">Notes:</span>{" "}
                  {returnData.inspectionNotes}
                </p>
              )}
              {returnData.inspectedBy && (
                <p>
                  <span className="font-medium text-sh-black">Inspected by:</span>{" "}
                  {returnData.inspectedBy}
                </p>
              )}
              {returnData.inspectedAt && (
                <p>
                  <span className="font-medium text-sh-black">Inspected at:</span>{" "}
                  {format(new Date(returnData.inspectedAt), "PPP p")}
                </p>
              )}
            </div>
          ) : returnData.status === "RECEIVED" ? (
            <>
              {!showInspectionForm ? (
                <Button size="sm" onClick={() => setShowInspectionForm(true)}>
                  Record Inspection
                </Button>
              ) : (
                <div className="space-y-3">
                  <div>
                    <label
                      htmlFor="inspection-condition"
                      className="block text-sm font-medium mb-1"
                    >
                      Condition
                    </label>
                    <select
                      id="inspection-condition"
                      value={inspectionCondition}
                      onChange={(e) => setInspectionCondition(e.target.value)}
                      className="w-full border border-sh-gray/30 rounded-lg px-3 py-2 text-sm"
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
                      className="w-full border border-sh-gray/30 rounded-lg px-3 py-2 text-sm"
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
            </>
          ) : (
            <p className="text-sm text-sh-gray">No inspection recorded yet.</p>
          )}
        </div>
      )}

      {/* Disposition Card */}
      {showDispositionCard && (
        <div className="bg-white p-6 rounded-lg shadow-md mb-6">
          <h2 className="text-xl font-semibold mb-3">Disposition</h2>
          {returnData.status === "RESTOCKED" && returnData.restockedLocation ? (
            <p className="text-sm">
              <span className="font-medium text-sh-black">Restocked to:</span>{" "}
              {returnData.restockedLocation}
            </p>
          ) : returnData.status === "WRITTEN_OFF" && returnData.writeOffReason ? (
            <p className="text-sm">
              <span className="font-medium text-sh-black">Write-off reason:</span>{" "}
              {returnData.writeOffReason}
            </p>
          ) : returnData.status === "INSPECTED" ? (
            <div className="space-y-3">
              {!showRestockForm && !showWriteOffForm && (
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => setShowRestockForm(true)}>
                    Restock
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setShowWriteOffForm(true)}>
                    Write Off
                  </Button>
                </div>
              )}

              {showRestockForm && (
                <div className="space-y-3">
                  <div>
                    <label htmlFor="restock-location" className="block text-sm font-medium mb-1">
                      Restock Location
                    </label>
                    <select
                      id="restock-location"
                      value={restockLocation}
                      onChange={(e) => setRestockLocation(e.target.value)}
                      className="w-full border border-sh-gray/30 rounded-lg px-3 py-2 text-sm"
                    >
                      <option value="">Select location...</option>
                      <option value="Main Showroom">Main Showroom</option>
                      <option value="Main Warehouse">Main Warehouse</option>
                      <option value="West Showroom">West Showroom</option>
                    </select>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={handleRestock} disabled={updating}>
                      {updating ? "Saving..." : "Confirm Restock"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setShowRestockForm(false);
                        setRestockLocation("");
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}

              {showWriteOffForm && (
                <div className="space-y-3">
                  <div>
                    <label htmlFor="writeoff-reason" className="block text-sm font-medium mb-1">
                      Write-Off Reason
                    </label>
                    <textarea
                      id="writeoff-reason"
                      value={writeOffReason}
                      onChange={(e) => setWriteOffReason(e.target.value)}
                      rows={3}
                      className="w-full border border-sh-gray/30 rounded-lg px-3 py-2 text-sm"
                      placeholder="Explain why the item cannot be restocked..."
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={handleWriteOff} disabled={updating}>
                      {updating ? "Saving..." : "Confirm Write Off"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setShowWriteOffForm(false);
                        setWriteOffReason("");
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-sh-gray">Pending disposition.</p>
          )}
        </div>
      )}

      {/* Refund Card */}
      <div className="bg-white p-6 rounded-lg shadow-md mb-6">
        <h2 className="text-xl font-semibold mb-3">Refund</h2>
        {returnData.refundAmount != null ? (
          <div className="text-sm space-y-1.5">
            <p>
              <span className="font-medium text-sh-black">Refund Amount:</span>{" "}
              {formatCurrency(returnData.refundAmount)}
            </p>
            {returnData.refundPaymentType && (
              <p>
                <span className="font-medium text-sh-black">Payment Method:</span>{" "}
                {returnData.refundPaymentType}
              </p>
            )}
          </div>
        ) : (
          <>
            {!showRefundForm ? (
              <Button size="sm" onClick={() => setShowRefundForm(true)}>
                Issue Refund
              </Button>
            ) : (
              <div className="space-y-3">
                <div>
                  <label htmlFor="refund-payment" className="block text-sm font-medium mb-1">
                    Original Payment
                  </label>
                  <select
                    id="refund-payment"
                    value={refundPaymentId}
                    onChange={(e) =>
                      setRefundPaymentId(e.target.value ? Number(e.target.value) : "")
                    }
                    className="w-full border border-sh-gray/30 rounded-lg px-3 py-2 text-sm"
                  >
                    <option value="">Select payment...</option>
                    {(returnData.payments || []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.paymentType} - {formatCurrency(p.paymentAmount)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="refund-amount" className="block text-sm font-medium mb-1">
                    Refund Amount
                  </label>
                  <input
                    id="refund-amount"
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={refundAmount}
                    onChange={(e) => setRefundAmount(e.target.value)}
                    className="w-full border border-sh-gray/30 rounded-lg px-3 py-2 text-sm"
                    placeholder="0.00"
                  />
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleIssueRefund} disabled={updating}>
                    {updating ? "Processing..." : "Submit Refund"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setShowRefundForm(false);
                      setRefundPaymentId("");
                      setRefundAmount("");
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Exchange Card */}
      <div className="bg-white p-6 rounded-lg shadow-md mb-6">
        <h2 className="text-xl font-semibold mb-3">Exchange</h2>
        {returnData.exchangeOrderId ? (
          <p className="text-sm">
            <span className="font-medium text-sh-black">Exchange Order:</span>{" "}
            <Link
              href={`/app/sales/orders/${returnData.exchangeOrderId}`}
              className="text-sh-blue hover:underline"
            >
              {returnData.exchangeOrderNo || `Order #${returnData.exchangeOrderId}`}
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
          {returnData.vendorReturnPOs && returnData.vendorReturnPOs.length > 0 ? (
            <div className="text-sm space-y-1">
              {returnData.vendorReturnPOs.map((po) => (
                <p key={po.id}>
                  <span className="font-medium text-sh-black">PO:</span> {po.poNumber}
                </p>
              ))}
            </div>
          ) : (
            <div>
              <p className="text-sm text-sh-gray mb-3">
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
          <p className="text-sm text-sh-gray">No return-related changes recorded yet.</p>
        ) : (
          <div className="space-y-3">
            {changeLog.map((entry) => (
              <div
                key={entry.id}
                className="flex items-start gap-3 text-sm border-b border-sh-gray/10 pb-2 last:border-0"
              >
                <div className="w-2 h-2 rounded-full bg-sh-blue mt-1.5 shrink-0" />
                <div className="flex-1">
                  <p className="font-medium">{entry.changeType.replace(/_/g, " ")}</p>
                  {entry.previousValue && entry.newValue && (
                    <p className="text-sh-gray">
                      {entry.previousValue} &rarr; {entry.newValue}
                    </p>
                  )}
                  {!entry.previousValue && entry.newValue && (
                    <p className="text-sh-gray">{entry.newValue}</p>
                  )}
                  {entry.reason && <p className="text-sh-gray italic">{entry.reason}</p>}
                </div>
                <div className="text-xs text-sh-gray whitespace-nowrap">
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
