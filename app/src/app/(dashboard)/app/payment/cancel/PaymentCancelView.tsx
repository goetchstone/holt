// /app/src/app/(dashboard)/app/payment/cancel/PaymentCancelView.tsx
//
// Stripe-redirect cancellation notice. App Router port of pages/payment/cancel.tsx.
// Fully static -- no client state or query params -- so it renders as a server
// component.

export function PaymentCancelView() {
  return (
    <div className="min-h-screen bg-sh-linen flex items-center justify-center px-4">
      <div className="bg-white rounded-lg shadow-md p-10 max-w-md w-full text-center">
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-amber-100">
          <svg
            className="h-8 w-8 text-amber-600"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </div>
        <h1 className="text-2xl font-serif font-bold text-sh-blue mb-3">Payment Cancelled</h1>
        <p className="text-sh-gray text-sm mb-2">
          Your payment was not processed. If you would like to try again, please contact us or use
          the payment link sent to your email.
        </p>
        <p className="text-sh-gray text-sm mt-6">You may close this window.</p>
      </div>
    </div>
  );
}
