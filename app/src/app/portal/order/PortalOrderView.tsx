"use client";

// /app/src/app/portal/order/PortalOrderView.tsx
//
// Public customer order portal view: order summary, line items, payment history,
// balance, and a Stripe pay-now flow. App Router port of pages/portal/order.tsx
// (the customer-facing chrome is kept local here -- portal must NOT show staff
// nav). Reads ?token= + ?paid= via useSearchParams. Hits the public
// /api/portal/* REST endpoints exactly as before.

import { useEffect, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import axios from "axios";
import { format } from "date-fns";
import { useBranding, useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { getErrorMessage } from "@/lib/toastError";

interface PortalOrder {
  id: number;
  orderno: string;
  orderDate: string;
  status: string;
  customer: {
    firstName?: string;
    lastName?: string;
  } | null;
  lineItems: {
    id: number;
    productName?: string;
    orderedQuantity: number;
    netPrice: number;
    vatAmount: number | null;
  }[];
  payments: {
    id: number;
    paymentDate: string;
    paymentType: string;
    paymentAmount: number;
  }[];
  totalAmount: number;
  totalPaid: number;
  balanceDue: number;
}

const STATUS_LABELS: Record<string, string> = {
  QUOTE: "Quote",
  ORDER: "Order",
  FULFILLED: "Fulfilled",
  CANCELLED: "Cancelled",
};

export function PortalOrderView() {
  const branding = useBranding();
  const fmt = useMoneyFormatter();
  const storeName = branding.companyName ?? branding.appName;

  const searchParams = useSearchParams();
  const token = searchParams?.get("token") ?? null;
  const paid = searchParams?.get("paid") ?? null;

  const [order, setOrder] = useState<PortalOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [paymentLoading, setPaymentLoading] = useState(false);
  const [paymentSuccess, setPaymentSuccess] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [payFull, setPayFull] = useState(true);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    if (paid === "true") {
      setPaymentSuccess(true);
    }
    axios
      .get(`/api/portal/order?token=${token}`)
      .then((res) => setOrder(res.data))
      .catch((err) => setError(getErrorMessage(err, "Unable to load order")))
      .finally(() => setLoading(false));
  }, [token, paid]);

  const handlePayNow = useCallback(async () => {
    if (!order || !token) return;
    const amt = payFull ? undefined : Number.parseFloat(paymentAmount);
    if (!payFull && (!amt || amt <= 0)) {
      setError("Please enter a valid payment amount.");
      return;
    }
    setPaymentLoading(true);
    setError(null);
    try {
      const res = await axios.post("/api/portal/pay", {
        token,
        amount: amt,
      });
      if (res.data.url) {
        globalThis.location.href = res.data.url;
      } else {
        setPaymentSuccess(true);
      }
    } catch (err) {
      setError(
        getErrorMessage(err, "Unable to create payment link. Please contact us for assistance."),
      );
    } finally {
      setPaymentLoading(false);
    }
  }, [order, token, payFull, paymentAmount]);

  return (
    <div className="min-h-screen bg-sh-linen">
      {/* Test mode banner */}
      <div className="bg-red-600 text-white text-center py-2 text-sm font-sans font-semibold tracking-wide">
        TEST MODE - NOT VISIBLE TO CUSTOMERS
      </div>

      {/* Header */}
      <header className="bg-white border-b border-sh-gray/20 py-6">
        <div className="max-w-3xl mx-auto px-4">
          <h1 className="text-2xl font-serif text-sh-blue tracking-wide">{storeName}</h1>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-8">
        {loading && (
          <div className="text-center py-16">
            <p className="text-sh-gray font-serif">Loading order details...</p>
          </div>
        )}

        {error && (
          <div className="bg-white rounded-lg shadow-sm p-8 text-center">
            <p className="text-red-700 font-serif">{error}</p>
          </div>
        )}

        {order && (
          <div className="space-y-6">
            {/* Order header */}
            <div className="bg-white rounded-lg shadow-sm p-6">
              <div className="flex justify-between items-start">
                <div>
                  <h2 className="text-xl font-serif font-semibold text-sh-blue">
                    Order {order.orderno}
                  </h2>
                  <p className="text-sm text-sh-gray mt-1">
                    {format(new Date(order.orderDate), "MMMM d, yyyy")}
                  </p>
                  {order.customer && (
                    <p className="text-sm text-sh-gray mt-0.5">
                      {order.customer.firstName} {order.customer.lastName}
                    </p>
                  )}
                </div>
                <span className="px-3 py-1 text-xs font-medium rounded-full bg-sh-linen text-sh-blue border border-sh-blue/20">
                  {STATUS_LABELS[order.status] || order.status}
                </span>
              </div>
            </div>

            {/* Line items */}
            <div className="bg-white rounded-lg shadow-sm p-6">
              <h3 className="text-lg font-serif font-semibold text-sh-blue mb-4">Items</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-sh-gray/20">
                      <th className="pb-2 font-serif font-semibold text-sh-black">Item</th>
                      <th className="pb-2 font-serif font-semibold text-sh-black text-right">
                        Qty
                      </th>
                      <th className="pb-2 font-serif font-semibold text-sh-black text-right">
                        Price
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {order.lineItems.map((item) => (
                      <tr key={item.id} className="border-b border-sh-gray/10">
                        <td className="py-3 text-sh-black">{item.productName || "Unnamed Item"}</td>
                        <td className="py-3 text-sh-gray text-right">{item.orderedQuantity}</td>
                        <td className="py-3 text-sh-black text-right">{fmt(item.netPrice)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Payment history */}
            {order.payments.length > 0 && (
              <div className="bg-white rounded-lg shadow-sm p-6">
                <h3 className="text-lg font-serif font-semibold text-sh-blue mb-4">
                  Payment History
                </h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-sh-gray/20">
                        <th className="pb-2 font-serif font-semibold text-sh-black">Date</th>
                        <th className="pb-2 font-serif font-semibold text-sh-black">Method</th>
                        <th className="pb-2 font-serif font-semibold text-sh-black text-right">
                          Amount
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {order.payments.map((p) => (
                        <tr key={p.id} className="border-b border-sh-gray/10">
                          <td className="py-3 text-sh-gray">
                            {format(new Date(p.paymentDate), "MMM d, yyyy")}
                          </td>
                          <td className="py-3 text-sh-gray">{p.paymentType}</td>
                          <td className="py-3 text-sh-black text-right">{fmt(p.paymentAmount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Balance summary */}
            <div className="bg-white rounded-lg shadow-sm p-6">
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-sh-gray">Order Total</span>
                  <span className="text-sh-black font-medium">{fmt(order.totalAmount)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sh-gray">Total Paid</span>
                  <span className="text-sh-black font-medium">{fmt(order.totalPaid)}</span>
                </div>
                <div className="border-t border-sh-gray/20 pt-2">
                  <div className="flex justify-between">
                    <span className="font-serif font-semibold text-sh-blue">Balance Due</span>
                    <span
                      className={`font-serif font-semibold text-lg ${
                        order.balanceDue > 0 ? "text-red-700" : "text-green-700"
                      }`}
                    >
                      {fmt(order.balanceDue)}
                    </span>
                  </div>
                </div>
              </div>

              {order.balanceDue > 0 && !paymentSuccess && (
                <div className="mt-6 space-y-4">
                  <div className="flex items-center justify-center gap-4">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="payOption"
                        checked={payFull}
                        onChange={() => setPayFull(true)}
                        className="w-4 h-4"
                      />
                      <span className="text-sm text-sh-black">
                        Pay in full ({fmt(order.balanceDue)})
                      </span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="payOption"
                        checked={!payFull}
                        onChange={() => setPayFull(false)}
                        className="w-4 h-4"
                      />
                      <span className="text-sm text-sh-black">Make a partial payment</span>
                    </label>
                  </div>

                  {!payFull && (
                    <div className="flex items-center justify-center gap-2">
                      <span className="text-sh-gray text-sm">$</span>
                      <input
                        type="number"
                        step="0.01"
                        min="1"
                        max={order.balanceDue}
                        value={paymentAmount}
                        onChange={(e) => setPaymentAmount(e.target.value)}
                        placeholder="Enter amount"
                        className="w-40 text-center border border-sh-gray/30 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-sh-gold"
                      />
                    </div>
                  )}

                  <div className="text-center">
                    <button
                      onClick={handlePayNow}
                      disabled={paymentLoading}
                      className="inline-flex items-center justify-center px-8 py-3 bg-sh-gold text-white font-serif font-semibold text-sm rounded-lg shadow-md hover:bg-sh-gold/90 transition disabled:opacity-50 disabled:cursor-not-allowed tracking-wide"
                    >
                      {renderPayButtonLabel(
                        paymentLoading,
                        payFull,
                        order.balanceDue,
                        paymentAmount,
                        fmt,
                      )}
                    </button>
                  </div>
                </div>
              )}

              {paymentSuccess && (
                <div className="mt-6 text-center bg-green-50 border border-green-200 rounded-lg p-4">
                  <p className="text-green-700 font-serif font-semibold">
                    Thank you for your payment!
                  </p>
                  <p className="text-green-600 text-sm mt-1">
                    Your payment has been processed. This page will update shortly.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-sh-gray/20 py-6 mt-12">
        <div className="max-w-3xl mx-auto px-4 text-center">
          <p className="text-xs text-sh-gray">{storeName}</p>
        </div>
      </footer>
    </div>
  );
}

// Extracted from the JSX to avoid a nested ternary in the pay-button label.
function renderPayButtonLabel(
  paymentLoading: boolean,
  payFull: boolean,
  balanceDue: number,
  paymentAmount: string,
  fmt: (value: number | null | undefined) => string,
): string {
  if (paymentLoading) return "Processing...";
  if (payFull) return `Pay ${fmt(balanceDue)}`;
  return `Pay ${paymentAmount ? fmt(Number.parseFloat(paymentAmount) || 0) : "..."}`;
}
