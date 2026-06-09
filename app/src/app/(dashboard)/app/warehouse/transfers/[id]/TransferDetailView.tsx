"use client";

// /app/src/app/(dashboard)/app/warehouse/transfers/[id]/TransferDetailView.tsx
//
// Transfer detail body (summary fields + status-transition actions). App Router
// port of the legacy pages/warehouse/transfers/[id].tsx body (minus MainLayout
// chrome, which comes from the (dashboard) layout). Reads the shared
// /api/warehouse/transfers/[id] REST endpoint. The route id arrives as a prop.

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import axios from "axios";
import { toast } from "react-toastify";
import { format } from "date-fns";
import { getErrorMessage } from "@/lib/toastError";
import { Button } from "@/components/ui/button";

interface TransferDetail {
  id: number;
  productId: number;
  productName: string;
  productNumber: string;
  quantity: number;
  fromLocation: string;
  fromLocationId: number | null;
  fromStockLocation: string | null;
  fromStockLocationId: number | null;
  toLocation: string;
  toLocationId: number | null;
  toStockLocation: string | null;
  toStockLocationId: number | null;
  status: string;
  notes: string | null;
  requestedBy: string;
  shippedAt: string | null;
  receivedAt: string | null;
  created: string;
}

const STATUS_STYLES: Record<string, string> = {
  DRAFT: "bg-sh-gray/20 text-sh-gray",
  IN_TRANSIT: "bg-blue-100 text-blue-800",
  RECEIVED: "bg-green-100 text-green-800",
  CANCELLED: "bg-red-100 text-red-800",
};

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  IN_TRANSIT: "In Transit",
  RECEIVED: "Received",
  CANCELLED: "Cancelled",
};

export function TransferDetailView({ id }: { id: string }) {
  const router = useRouter();
  const [transfer, setTransfer] = useState<TransferDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    if (!id) return;
    axios
      .get(`/api/warehouse/transfers/${encodeURIComponent(String(id))}`)
      .then((res) => setTransfer(res.data))
      .catch(() => toast.error("Failed to load transfer"))
      .finally(() => setLoading(false));
  }, [id]);

  const updateStatus = async (newStatus: string) => {
    if (!transfer) return;
    setUpdating(true);
    try {
      await axios.put(`/api/warehouse/transfers/${transfer.id}/status`, { status: newStatus });
      const res = await axios.get(`/api/warehouse/transfers/${transfer.id}`);
      setTransfer(res.data);
      toast.success(`Transfer ${STATUS_LABELS[newStatus]?.toLowerCase() || newStatus}`);
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, "Failed to update status"));
    } finally {
      setUpdating(false);
    }
  };

  if (loading) {
    return (
      <div className="py-2 font-serif">
        <p className="text-sh-gray">Loading...</p>
      </div>
    );
  }

  if (!transfer) {
    return (
      <div className="py-2 font-serif">
        <p className="text-sh-gray">Transfer not found</p>
      </div>
    );
  }

  const formatLoc = (name: string, stockLoc: string | null) =>
    stockLoc ? `${name} - ${stockLoc}` : name;

  return (
    <div className="py-2 space-y-6 font-serif">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl text-sh-blue font-semibold">Transfer #{transfer.id}</h1>
        <span
          className={`text-sm px-3 py-1 rounded ${STATUS_STYLES[transfer.status] || "bg-sh-gray/20 text-sh-gray"}`}
        >
          {STATUS_LABELS[transfer.status] || transfer.status}
        </span>
      </div>

      {/* Summary */}
      <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-sh-gray mb-1">Product</p>
            <p className="text-sh-black font-medium">{transfer.productName}</p>
            <p className="text-sh-gray text-xs">{transfer.productNumber}</p>
          </div>
          <div>
            <p className="text-sh-gray mb-1">Quantity</p>
            <p className="text-sh-black font-medium">{transfer.quantity}</p>
          </div>
          <div>
            <p className="text-sh-gray mb-1">From</p>
            <p className="text-sh-black">
              {formatLoc(transfer.fromLocation, transfer.fromStockLocation)}
            </p>
          </div>
          <div>
            <p className="text-sh-gray mb-1">To</p>
            <p className="text-sh-black">
              {formatLoc(transfer.toLocation, transfer.toStockLocation)}
            </p>
          </div>
          <div>
            <p className="text-sh-gray mb-1">Requested By</p>
            <p className="text-sh-black">{transfer.requestedBy}</p>
          </div>
          <div>
            <p className="text-sh-gray mb-1">Requested</p>
            <p className="text-sh-black">
              {format(new Date(transfer.created), "MMM d, yyyy h:mm a")}
            </p>
          </div>
          {transfer.shippedAt && (
            <div>
              <p className="text-sh-gray mb-1">Shipped</p>
              <p className="text-sh-black">
                {format(new Date(transfer.shippedAt), "MMM d, yyyy h:mm a")}
              </p>
            </div>
          )}
          {transfer.receivedAt && (
            <div>
              <p className="text-sh-gray mb-1">Received</p>
              <p className="text-sh-black">
                {format(new Date(transfer.receivedAt), "MMM d, yyyy h:mm a")}
              </p>
            </div>
          )}
          {transfer.notes && (
            <div className="sm:col-span-2">
              <p className="text-sh-gray mb-1">Notes</p>
              <p className="text-sh-black">{transfer.notes}</p>
            </div>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-3">
        {transfer.status === "DRAFT" && (
          <>
            <Button size="sm" onClick={() => updateStatus("IN_TRANSIT")} disabled={updating}>
              Mark Shipped
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => updateStatus("CANCELLED")}
              disabled={updating}
            >
              Cancel
            </Button>
          </>
        )}
        {transfer.status === "IN_TRANSIT" && (
          <>
            <Button size="sm" onClick={() => updateStatus("RECEIVED")} disabled={updating}>
              Mark Received
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => updateStatus("CANCELLED")}
              disabled={updating}
            >
              Cancel
            </Button>
          </>
        )}
        <Button variant="outline" size="sm" onClick={() => router.push("/app/warehouse/transfers")}>
          Back to Transfers
        </Button>
      </div>
    </div>
  );
}
