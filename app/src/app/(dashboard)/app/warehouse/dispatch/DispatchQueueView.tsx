"use client";

// /app/src/app/(dashboard)/app/warehouse/dispatch/DispatchQueueView.tsx
//
// Dispatch queue body (pending + ready tabs, dispatch-status progression). App
// Router port of the legacy pages/warehouse/dispatch.tsx body (minus MainLayout
// chrome, which comes from the (dashboard) layout). Reads the shared
// /api/warehouse/dispatch/* + /api/sales/orders REST endpoints.

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import axios from "axios";
import { toast } from "react-toastify";
import { format } from "date-fns";
import { getErrorMessage } from "@/lib/toastError";

interface PendingOrder {
  id: number;
  orderno: string;
  customerName: string;
  orderDate: string;
  dispatchStatus: string;
  deliveryMethod: string | null;
  scheduledDeliveryDate: string | null;
  totalItems: number;
  receivedItems: number;
  allReceived: boolean;
}

interface ReadyOrder {
  id: number;
  orderno: string;
  customerName: string;
  customerZip: string | null;
  orderDate: string;
  dispatchStatus: string;
  deliveryMethod: string | null;
  scheduledDeliveryDate: string | null;
  deliveryNotes: string | null;
  itemCount: number;
}

const DISPATCH_LABELS: Record<string, string> = {
  PO_PLACED: "PO Placed",
  RECEIVED_IN_WAREHOUSE: "In Warehouse",
  READY_FOR_PICKUP: "Ready for Pickup",
  SCHEDULED_DELIVERY: "Delivery Scheduled",
  FULFILLED: "Fulfilled",
  CANCELLED: "Cancelled",
};

const DISPATCH_STYLES: Record<string, string> = {
  PO_PLACED: "bg-sh-gray/20 text-sh-gray",
  RECEIVED_IN_WAREHOUSE: "bg-yellow-100 text-yellow-800",
  READY_FOR_PICKUP: "bg-blue-100 text-blue-800",
  SCHEDULED_DELIVERY: "bg-green-100 text-green-800",
  FULFILLED: "bg-green-100 text-green-800",
  CANCELLED: "bg-red-100 text-red-800",
};

export function DispatchQueueView() {
  const router = useRouter();
  const [tab, setTab] = useState<"pending" | "ready">("pending");
  const [pending, setPending] = useState<PendingOrder[]>([]);
  const [ready, setReady] = useState<ReadyOrder[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = async () => {
    setLoading(true);
    try {
      const [pendingRes, readyRes] = await Promise.all([
        axios.get("/api/warehouse/dispatch/pending"),
        axios.get("/api/warehouse/dispatch/ready"),
      ]);
      setPending(pendingRes.data.orders);
      setReady(readyRes.data.orders);
    } catch {
      setPending([]);
      setReady([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const updateDispatch = async (orderId: number, dispatchStatus: string) => {
    try {
      await axios.put(`/api/sales/orders/${orderId}/dispatch`, { dispatchStatus });
      toast.success(`Order updated to ${DISPATCH_LABELS[dispatchStatus] || dispatchStatus}`);
      loadData();
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, "Failed to update status"));
    }
  };

  return (
    <div className="py-2 space-y-4 font-serif">
      <h1 className="text-2xl text-sh-blue font-semibold">Dispatch Queue</h1>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-sh-gray/20">
        <button
          onClick={() => setTab("pending")}
          className={`px-4 py-2 text-sm font-medium transition border-b-2 -mb-px ${
            tab === "pending"
              ? "border-sh-blue text-sh-blue"
              : "border-transparent text-sh-gray hover:text-sh-black"
          }`}
        >
          Pending ({pending.length})
        </button>
        <button
          onClick={() => setTab("ready")}
          className={`px-4 py-2 text-sm font-medium transition border-b-2 -mb-px ${
            tab === "ready"
              ? "border-sh-blue text-sh-blue"
              : "border-transparent text-sh-gray hover:text-sh-black"
          }`}
        >
          Ready ({ready.length})
        </button>
      </div>

      {loading ? (
        <p className="text-sh-gray">Loading...</p>
      ) : tab === "pending" ? (
        <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-sh-gray/20 bg-sh-stripe">
                <th className="text-left px-4 py-3 font-medium text-sh-gray">Order</th>
                <th className="text-left px-4 py-3 font-medium text-sh-gray">Customer</th>
                <th className="text-left px-4 py-3 font-medium text-sh-gray w-[100px]">Status</th>
                <th className="text-right px-4 py-3 font-medium text-sh-gray w-[100px]">Items</th>
                <th className="text-right px-4 py-3 font-medium text-sh-gray w-[120px]">Actions</th>
              </tr>
            </thead>
            <tbody>
              {pending.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-sh-gray">
                    No pending orders
                  </td>
                </tr>
              ) : (
                pending.map((order) => (
                  <tr
                    key={order.id}
                    className="border-b border-sh-gray/10 hover:bg-sh-stripe/50 cursor-pointer"
                    onClick={() => router.push(`/app/sales/orders/${order.id}`)}
                  >
                    <td className="px-4 py-2 text-sh-black font-medium">{order.orderno}</td>
                    <td className="px-4 py-2 text-sh-gray">{order.customerName}</td>
                    <td className="px-4 py-2">
                      <span
                        className={`text-xs px-2 py-0.5 rounded ${DISPATCH_STYLES[order.dispatchStatus] || "bg-sh-gray/20 text-sh-gray"}`}
                      >
                        {DISPATCH_LABELS[order.dispatchStatus] || order.dispatchStatus}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right text-sh-gray">
                      <span
                        className={
                          order.allReceived ? "text-green-700 font-medium" : "text-sh-gray"
                        }
                      >
                        {order.receivedItems}/{order.totalItems}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right">
                      {order.allReceived && order.dispatchStatus === "PO_PLACED" && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={(e) => {
                            e.stopPropagation();
                            updateDispatch(order.id, "RECEIVED_IN_WAREHOUSE");
                          }}
                        >
                          Mark Received
                        </Button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-sh-gray/20 bg-sh-stripe">
                <th className="text-left px-4 py-3 font-medium text-sh-gray">Order</th>
                <th className="text-left px-4 py-3 font-medium text-sh-gray">Customer</th>
                <th className="text-left px-4 py-3 font-medium text-sh-gray w-[80px]">ZIP</th>
                <th className="text-left px-4 py-3 font-medium text-sh-gray w-[110px]">Status</th>
                <th className="text-left px-4 py-3 font-medium text-sh-gray w-[100px]">Delivery</th>
                <th className="text-right px-4 py-3 font-medium text-sh-gray w-[200px]">Actions</th>
              </tr>
            </thead>
            <tbody>
              {ready.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-sh-gray">
                    No orders ready for dispatch
                  </td>
                </tr>
              ) : (
                ready.map((order) => (
                  <tr
                    key={order.id}
                    className="border-b border-sh-gray/10 hover:bg-sh-stripe/50 cursor-pointer"
                    onClick={() => router.push(`/app/sales/orders/${order.id}`)}
                  >
                    <td className="px-4 py-2 text-sh-black font-medium">{order.orderno}</td>
                    <td className="px-4 py-2 text-sh-gray">{order.customerName}</td>
                    <td className="px-4 py-2 text-sh-gray text-xs">{order.customerZip || ""}</td>
                    <td className="px-4 py-2">
                      <span
                        className={`text-xs px-2 py-0.5 rounded ${DISPATCH_STYLES[order.dispatchStatus] || "bg-sh-gray/20 text-sh-gray"}`}
                      >
                        {DISPATCH_LABELS[order.dispatchStatus] || order.dispatchStatus}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-sh-gray text-xs">
                      {order.scheduledDeliveryDate
                        ? format(new Date(order.scheduledDeliveryDate), "MMM d")
                        : ""}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <div
                        className="flex gap-1 justify-end"
                        role="presentation"
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                      >
                        {order.dispatchStatus === "RECEIVED_IN_WAREHOUSE" && (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => updateDispatch(order.id, "SCHEDULED_DELIVERY")}
                            >
                              Schedule
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => updateDispatch(order.id, "READY_FOR_PICKUP")}
                            >
                              Pickup
                            </Button>
                          </>
                        )}
                        {(order.dispatchStatus === "READY_FOR_PICKUP" ||
                          order.dispatchStatus === "SCHEDULED_DELIVERY") && (
                          <Button size="sm" onClick={() => updateDispatch(order.id, "FULFILLED")}>
                            Fulfilled
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
      )}
    </div>
  );
}
