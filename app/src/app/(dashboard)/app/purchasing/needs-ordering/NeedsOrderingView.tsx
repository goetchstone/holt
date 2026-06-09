"use client";

// /app/src/app/(dashboard)/app/purchasing/needs-ordering/NeedsOrderingView.tsx
//
// Needs Ordering -- sales orders with status ORDER that don't yet have purchase
// orders. App Router port; reads the shared /api/purchasing/needs-ordering +
// /api/sales/orders/[id]/create-po REST endpoints (used outside this domain), so
// they stay REST. Chrome from the (dashboard) layout.

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import axios from "axios";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { toast } from "react-toastify";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";

interface NeedsOrderingRow {
  id: number;
  orderno: string;
  orderDate: string;
  customerName: string | null;
  itemCount: number;
  total: number;
}

export function NeedsOrderingView() {
  const router = useRouter();
  const formatCurrency = useMoneyFormatter();
  const [orders, setOrders] = useState<NeedsOrderingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState<number | null>(null);

  const fetchOrders = useCallback(async () => {
    try {
      const res = await axios.get("/api/purchasing/needs-ordering");
      setOrders(res.data.orders || []);
    } catch {
      toast.error("Failed to load orders.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  const handleCreatePO = async (orderId: number) => {
    setCreating(orderId);
    try {
      const res = await axios.post(`/api/sales/orders/${orderId}/create-po`);
      const poIds: number[] = res.data.purchaseOrderIds || [];
      toast.success(`Created ${poIds.length} purchase order(s).`);
      if (poIds.length === 1) {
        router.push(`/app/purchasing/orders/${poIds[0]}`);
      } else {
        setOrders((prev) => prev.filter((o) => o.id !== orderId));
      }
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err) ? err.response?.data?.error : "Failed to create PO.";
      toast.error(msg || "Failed to create PO.");
    } finally {
      setCreating(null);
    }
  };

  return (
    <div className="py-2 space-y-6 font-serif">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl text-sh-blue font-semibold">Needs Ordering</h1>
        <Button variant="secondary" onClick={() => router.push("/app/purchasing")}>
          Back to Purchasing
        </Button>
      </div>

      <p className="text-sm text-sh-gray">
        Sales orders with status ORDER that do not yet have purchase orders.
      </p>

      {loading ? (
        <p className="text-sh-gray">Loading...</p>
      ) : orders.length === 0 ? (
        <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-8 text-center">
          <p className="text-sh-gray">All orders have purchase orders created.</p>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow-md overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm whitespace-nowrap">
              <thead className="bg-sh-linen text-sh-black">
                <tr>
                  <th className="p-3 border-b">Order #</th>
                  <th className="p-3 border-b">Customer</th>
                  <th className="p-3 border-b">Date</th>
                  <th className="p-3 border-b text-center">Items</th>
                  <th className="p-3 border-b text-right">Total</th>
                  <th className="p-3 border-b text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr key={order.id} className="odd:bg-white even:bg-sh-stripe">
                    <td className="p-3 border-b">
                      <button
                        className="text-sh-blue hover:underline font-medium"
                        onClick={() => router.push(`/app/sales/orders/${order.id}`)}
                      >
                        {order.orderno}
                      </button>
                    </td>
                    <td className="p-3 border-b">{order.customerName || "Walk-in"}</td>
                    <td className="p-3 border-b">
                      {order.orderDate ? format(new Date(order.orderDate), "PPP") : "N/A"}
                    </td>
                    <td className="p-3 border-b text-center">{order.itemCount}</td>
                    <td className="p-3 border-b text-right">{formatCurrency(order.total)}</td>
                    <td className="p-3 border-b text-right">
                      <Button
                        size="sm"
                        onClick={() => handleCreatePO(order.id)}
                        disabled={creating === order.id}
                      >
                        {creating === order.id ? "Creating..." : "Create PO"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
