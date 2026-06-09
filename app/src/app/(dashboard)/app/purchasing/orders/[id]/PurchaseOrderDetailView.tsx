"use client";

// /app/src/app/(dashboard)/app/purchasing/orders/[id]/PurchaseOrderDetailView.tsx
//
// Purchase Order detail. App Router port; reads the shared
// /api/purchasing/orders/[id] REST endpoint (GET + PUT), which stays REST.
// Chrome from the (dashboard) layout. The id arrives as a prop from the server
// page (params awaited there).

import { useEffect, useState, useCallback } from "react";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { toast } from "react-toastify";
import Link from "next/link";
import { format } from "date-fns";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";

interface ReceivingDetail {
  id: number;
  quantityReceived: number;
  receivedDate: string;
  destinationLocation?: string;
  invoiceNumber?: string;
  lineCost: number | null;
  externalPorNo?: string;
}

interface LineItem {
  id: number;
  partNo?: string;
  productName?: string;
  productNumber?: string;
  orderedQuantity: number;
  unitCost: number;
  lineTotal: number;
  totalReceived: number;
  salesOrderNo: string | null;
  selectedGrade?: string;
  selectedFinish?: string;
  receivingRecords: ReceivingDetail[];
}

interface SalesOrderRef {
  id: number;
  orderno: string;
  customerName: string | null;
}

interface PODetails {
  id: number;
  poNumber: string;
  vendor: { id: number; name: string };
  salesOrder: SalesOrderRef | null;
  orderDate: string;
  expectedDelivery?: string;
  estimatedShipDate?: string;
  vendorAckNumber?: string;
  vendorAckDate?: string;
  status: string;
  notes?: string;
  created: string;
  updated?: string;
  lineItems: LineItem[];
}

const STATUS_STYLES: Record<string, string> = {
  DRAFT: "bg-sh-gray/20 text-sh-gray",
  SUBMITTED: "bg-blue-100 text-blue-800",
  CONFIRMED: "bg-yellow-100 text-yellow-800",
  RECEIVED_PARTIAL: "bg-orange-100 text-orange-800",
  RECEIVED_FULL: "bg-green-100 text-green-800",
  SHORT_CLOSED: "bg-purple-100 text-purple-800",
  CANCELLED: "bg-red-100 text-red-800",
};

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Submitted",
  CONFIRMED: "Confirmed",
  RECEIVED_PARTIAL: "Partially Received",
  RECEIVED_FULL: "Fully Received",
  SHORT_CLOSED: "Short Closed",
  CANCELLED: "Cancelled",
};

export function PurchaseOrderDetailView({ id }: { id: string }) {
  const formatCurrency = useMoneyFormatter();
  const [po, setPo] = useState<PODetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [transitioning, setTransitioning] = useState(false);

  // Local state for acknowledgement fields
  const [ackNumber, setAckNumber] = useState("");
  const [ackDate, setAckDate] = useState("");
  const [shipDate, setShipDate] = useState("");
  const [deliveryDate, setDeliveryDate] = useState("");

  const fetchPO = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const res = await axios.get(`/api/purchasing/orders/${encodeURIComponent(String(id))}`);
      const data = res.data as PODetails;
      setPo(data);
      setAckNumber(data.vendorAckNumber || "");
      setAckDate(data.vendorAckDate ? data.vendorAckDate.slice(0, 10) : "");
      setShipDate(data.estimatedShipDate ? data.estimatedShipDate.slice(0, 10) : "");
      setDeliveryDate(data.expectedDelivery ? data.expectedDelivery.slice(0, 10) : "");
    } catch {
      toast.error("Failed to load purchase order.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchPO();
  }, [fetchPO]);

  const saveField = async (field: string, value: string) => {
    if (!po) return;
    setSaving(true);
    try {
      await axios.put(`/api/purchasing/orders/${po.id}`, { [field]: value || null });
    } catch {
      toast.error("Failed to save.");
    } finally {
      setSaving(false);
    }
  };

  const handleStatusTransition = async (newStatus: string) => {
    if (!po) return;

    if (newStatus === "CONFIRMED" && !ackNumber) {
      toast.error("Vendor acknowledgement number is required to confirm.");
      return;
    }

    setTransitioning(true);
    try {
      await axios.put(`/api/purchasing/orders/${po.id}`, {
        status: newStatus,
        vendorAckNumber: ackNumber || undefined,
      });
      toast.success(`Status updated to ${STATUS_LABELS[newStatus] || newStatus}.`);
      fetchPO();
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err) ? err.response?.data?.error : "Failed to update status.";
      toast.error(msg || "Failed to update status.");
    } finally {
      setTransitioning(false);
    }
  };

  if (loading) {
    return <p>Loading purchase order...</p>;
  }

  if (!po) {
    return <p>Purchase order not found.</p>;
  }

  const totalCost = po.lineItems.reduce((sum, item) => sum + item.lineTotal, 0);
  const totalOrdered = po.lineItems.reduce((sum, item) => sum + item.orderedQuantity, 0);
  const totalReceived = po.lineItems.reduce((sum, item) => sum + item.totalReceived, 0);

  const allReceivingRecords = po.lineItems.flatMap((item) =>
    item.receivingRecords.map((r) => ({
      ...r,
      partNo: item.partNo,
      productName: item.productName,
    })),
  );

  function lineStatus(item: LineItem): { label: string; style: string } {
    // A 0-qty line came across from the POS as an effectively-cancelled
    // line. Mark it "N/A" so it doesn't read as blocking receipt. GitHub #113.
    if (item.orderedQuantity <= 0) {
      return { label: "N/A", style: "bg-sh-gray/10 text-sh-gray italic" };
    }
    if (item.totalReceived >= item.orderedQuantity) {
      return { label: "Received", style: "bg-green-100 text-green-800" };
    }
    if (item.totalReceived > 0) {
      return { label: "Partial", style: "bg-orange-100 text-orange-800" };
    }
    return { label: "Pending", style: "bg-sh-gray/20 text-sh-gray" };
  }

  const canSubmit = po.status === "DRAFT";
  const canConfirm = po.status === "SUBMITTED";
  const isEditable = !["RECEIVED_FULL", "SHORT_CLOSED", "CANCELLED"].includes(po.status);

  return (
    <div className="max-w-4xl mx-auto mt-8 font-serif">
      {/* Header */}
      <div className="flex justify-between items-start mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-sh-blue">PO {po.poNumber}</h1>
          <p className="text-sm text-sh-gray mt-1">
            {po.vendor.name} -- Ordered {format(new Date(po.orderDate), "PPP")}
          </p>
          <span
            className={`inline-block mt-2 text-xs px-2 py-0.5 rounded ${STATUS_STYLES[po.status] || ""}`}
          >
            {STATUS_LABELS[po.status] || po.status}
          </span>
          {po.salesOrder && (
            <p className="text-sm mt-2">
              <span className="text-sh-gray">Sales Order: </span>
              <Link
                href={`/app/sales/orders/${po.salesOrder.id}`}
                className="text-sh-blue hover:underline font-medium"
              >
                {po.salesOrder.orderno}
              </Link>
              {po.salesOrder.customerName && (
                <span className="text-sh-gray ml-2">({po.salesOrder.customerName})</span>
              )}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          {canSubmit && (
            <Button onClick={() => handleStatusTransition("SUBMITTED")} disabled={transitioning}>
              {transitioning ? "Updating..." : "Submit to Vendor"}
            </Button>
          )}
          {canConfirm && (
            <Button onClick={() => handleStatusTransition("CONFIRMED")} disabled={transitioning}>
              {transitioning ? "Updating..." : "Mark Acknowledged"}
            </Button>
          )}
          {po.status === "RECEIVED_PARTIAL" && (
            <Button
              variant="outline"
              onClick={() => {
                if (
                  confirm(
                    "Short close this PO? This marks it as complete even though not all items were received. This cannot be undone.",
                  )
                ) {
                  handleStatusTransition("SHORT_CLOSED");
                }
              }}
              disabled={transitioning}
            >
              Short Close
            </Button>
          )}
          {po.status !== "CANCELLED" &&
            po.status !== "RECEIVED_FULL" &&
            po.status !== "SHORT_CLOSED" && (
              <Link href={`/app/purchasing/orders/${po.id}/receive`}>
                <Button variant="secondary">Receive Shipment</Button>
              </Link>
            )}
          <Link href="/app/purchasing/orders">
            <Button variant="secondary">Back to Purchase Orders</Button>
          </Link>
        </div>
      </div>

      {/* Summary */}
      <div className="bg-white p-6 rounded-lg shadow-md mb-6">
        <h2 className="text-xl font-semibold mb-3">Summary</h2>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <p>
              <strong>Vendor:</strong> {po.vendor.name}
            </p>
            <p>
              <strong>Order Date:</strong> {format(new Date(po.orderDate), "PPP")}
            </p>
            {po.notes && (
              <p>
                <strong>Notes:</strong> {po.notes}
              </p>
            )}
          </div>
          <div>
            <p>
              <strong>Total Cost:</strong> {formatCurrency(totalCost)}
            </p>
            <p>
              <strong>Line Items:</strong> {po.lineItems.length}
            </p>
            <p>
              <strong>Units Ordered:</strong> {totalOrdered}
            </p>
            <p>
              <strong>Units Received:</strong> {totalReceived} / {totalOrdered}
            </p>
          </div>
        </div>
      </div>

      {/* Acknowledgement */}
      <div className="bg-white p-6 rounded-lg shadow-md mb-6">
        <h2 className="text-xl font-semibold mb-3">Acknowledgement</h2>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <label className="block text-sh-gray mb-1" htmlFor="ack-number">
              Vendor Ack #
            </label>
            <input
              id="ack-number"
              type="text"
              className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm disabled:bg-sh-linen"
              value={ackNumber}
              onChange={(e) => setAckNumber(e.target.value)}
              onBlur={() => saveField("vendorAckNumber", ackNumber)}
              disabled={!isEditable || saving}
              placeholder="Enter vendor ack number"
            />
          </div>
          <div>
            <label className="block text-sh-gray mb-1" htmlFor="ack-date">
              Ack Date
            </label>
            <input
              id="ack-date"
              type="date"
              className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm disabled:bg-sh-linen"
              value={ackDate}
              onChange={(e) => {
                setAckDate(e.target.value);
                saveField("vendorAckDate", e.target.value);
              }}
              disabled={!isEditable || saving}
            />
          </div>
          <div>
            <label className="block text-sh-gray mb-1" htmlFor="ship-date">
              Estimated Ship Date
            </label>
            <input
              id="ship-date"
              type="date"
              className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm disabled:bg-sh-linen"
              value={shipDate}
              onChange={(e) => {
                setShipDate(e.target.value);
                saveField("estimatedShipDate", e.target.value);
              }}
              disabled={!isEditable || saving}
            />
          </div>
          <div>
            <label className="block text-sh-gray mb-1" htmlFor="delivery-date">
              Expected Delivery
            </label>
            <input
              id="delivery-date"
              type="date"
              className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm disabled:bg-sh-linen"
              value={deliveryDate}
              onChange={(e) => {
                setDeliveryDate(e.target.value);
                saveField("expectedDelivery", e.target.value);
              }}
              disabled={!isEditable || saving}
            />
          </div>
        </div>
      </div>

      {/* Line Items */}
      <div className="bg-white p-6 rounded-lg shadow-md mb-6">
        <h2 className="text-xl font-semibold mb-3">Line Items</h2>
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm whitespace-nowrap">
            <thead className="bg-sh-linen text-sh-black">
              <tr>
                <th className="p-2 border-b">Part #</th>
                <th className="p-2 border-b">Product</th>
                <th className="p-2 border-b">Qty</th>
                <th className="p-2 border-b">Unit Cost</th>
                <th className="p-2 border-b">Total</th>
                <th className="p-2 border-b">Received</th>
                <th className="p-2 border-b">Status</th>
              </tr>
            </thead>
            <tbody>
              {po.lineItems.map((item) => {
                const status = lineStatus(item);
                return (
                  <tr key={item.id} className="odd:bg-white even:bg-sh-stripe">
                    <td className="p-2 border-b">{item.partNo || item.productNumber || "--"}</td>
                    <td className="p-2 border-b max-w-[200px] truncate">
                      {item.productName || "--"}
                      {item.selectedGrade && (
                        <span className="text-xs text-sh-gray ml-1">({item.selectedGrade})</span>
                      )}
                      {item.salesOrderNo && (
                        <span className="text-xs text-sh-blue ml-2">SO: {item.salesOrderNo}</span>
                      )}
                    </td>
                    <td className="p-2 border-b">{item.orderedQuantity}</td>
                    <td className="p-2 border-b">{formatCurrency(item.unitCost)}</td>
                    <td className="p-2 border-b">{formatCurrency(item.lineTotal)}</td>
                    <td className="p-2 border-b">
                      {item.totalReceived} / {item.orderedQuantity}
                    </td>
                    <td className="p-2 border-b">
                      <span className={`text-xs px-2 py-0.5 rounded ${status.style}`}>
                        {status.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Receiving Records */}
      {allReceivingRecords.length > 0 && (
        <div className="bg-white p-6 rounded-lg shadow-md mb-6">
          <h2 className="text-xl font-semibold mb-3">Receiving Records</h2>
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm whitespace-nowrap">
              <thead className="bg-sh-linen text-sh-black">
                <tr>
                  <th className="p-2 border-b">Date</th>
                  <th className="p-2 border-b">POR #</th>
                  <th className="p-2 border-b">Part #</th>
                  <th className="p-2 border-b">Qty</th>
                  <th className="p-2 border-b">Cost</th>
                  <th className="p-2 border-b">Destination</th>
                  <th className="p-2 border-b">Invoice #</th>
                </tr>
              </thead>
              <tbody>
                {allReceivingRecords.map((r) => (
                  <tr key={r.id} className="odd:bg-white even:bg-sh-stripe">
                    <td className="p-2 border-b">
                      {r.receivedDate ? format(new Date(r.receivedDate), "PPP") : "--"}
                    </td>
                    <td className="p-2 border-b">{r.externalPorNo || "--"}</td>
                    <td className="p-2 border-b">{r.partNo || "--"}</td>
                    <td className="p-2 border-b">{r.quantityReceived}</td>
                    <td className="p-2 border-b">
                      {r.lineCost != null ? formatCurrency(r.lineCost) : "--"}
                    </td>
                    <td className="p-2 border-b">{r.destinationLocation || "--"}</td>
                    <td className="p-2 border-b">{r.invoiceNumber || "--"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Audit */}
      <div className="text-xs text-sh-gray mb-8">
        Created: {po.created ? format(new Date(po.created), "PPP") : "N/A"}
        {po.updated && <> | Updated: {format(new Date(po.updated), "PPP")}</>}
      </div>
    </div>
  );
}
