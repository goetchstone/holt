"use client";

// /app/src/app/(dashboard)/app/payment/success/PaymentSuccessView.tsx
//
// Stripe-redirect success confirmation view. App Router port of
// pages/payment/success.tsx -- reads ?session_id= via useSearchParams and
// best-effort confirms the Stripe session against /api/stripe/session-status.

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

interface SessionStatus {
  status: string;
  payment_status: string;
  customer_email?: string;
  orderId?: string;
  orderno?: string;
}

export function PaymentSuccessView() {
  const searchParams = useSearchParams();
  const sessionId = searchParams?.get("session_id") ?? null;

  const [sessionData, setSessionData] = useState<SessionStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!sessionId) return;

    fetch(`/api/stripe/session-status?session_id=${encodeURIComponent(sessionId)}`)
      .then((res) => res.json())
      .then((data) => setSessionData(data))
      .catch(() => {
        // Session lookup is best-effort for the confirmation page
      })
      .finally(() => setLoading(false));
  }, [sessionId]);

  return (
    <div className="min-h-screen bg-sh-linen flex items-center justify-center px-4">
      <div className="bg-white rounded-lg shadow-md p-10 max-w-md w-full text-center">
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
          <svg
            className="h-8 w-8 text-green-600"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h1 className="text-2xl font-serif font-bold text-sh-blue mb-3">Payment Received</h1>
        {loading ? (
          <p className="text-sh-gray text-sm">Confirming payment...</p>
        ) : (
          <>
            <p className="text-sh-gray text-sm mb-2">
              Thank you for your payment.
              {sessionData?.orderno && <> Your order {sessionData.orderno} has been updated.</>}
            </p>
            <p className="text-sh-gray text-sm mt-6">You may close this window.</p>
          </>
        )}
      </div>
    </div>
  );
}
