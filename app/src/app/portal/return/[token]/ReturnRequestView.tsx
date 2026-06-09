"use client";

// /app/src/app/portal/return/[token]/ReturnRequestView.tsx
//
// Public customer return-request view: shows the return line and lets the
// customer pick a reason + notes and submit. App Router port of
// pages/portal/return/[token].tsx (customer-facing chrome kept local -- portal
// must NOT show staff nav). The token arrives as a prop from the server page.
// Hits the public /api/portal/returns/* REST endpoints exactly as before.

import { useState, useEffect, useCallback } from "react";
import { useBranding } from "@/components/branding/BrandingProvider";

const REASON_OPTIONS = [
  { value: "DEFECTIVE", label: "Defective product" },
  { value: "DAMAGED_IN_DELIVERY", label: "Damaged during delivery" },
  { value: "WRONG_ITEM", label: "Wrong item received" },
  { value: "CUSTOMER_CHANGED_MIND", label: "Changed my mind" },
  { value: "NOT_AS_DESCRIBED", label: "Not as described" },
  { value: "DUPLICATE_ORDER", label: "Duplicate order" },
  { value: "OTHER", label: "Other" },
];

interface ReturnInfo {
  returnNumber: string;
  status: string;
  reason: string;
  productName: string | null;
  quantity: number;
  created: string;
  customerNotes: string | null;
}

export function ReturnRequestView({ token }: { token: string }) {
  const branding = useBranding();
  const storeName = branding.companyName ?? branding.appName;

  const [returnInfo, setReturnInfo] = useState<ReturnInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [reason, setReason] = useState("");
  const [reasonNotes, setReasonNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!token) return;

    fetch(`/api/portal/returns/${encodeURIComponent(token)}`)
      .then((res) => {
        if (!res.ok) throw new Error("Invalid or expired return link");
        return res.json();
      })
      .then((data) => {
        setReturnInfo(data);
        if (data.customerNotes || data.status !== "INITIATED") {
          setSubmitted(true);
        }
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Invalid or expired return link"),
      )
      .finally(() => setLoading(false));
  }, [token]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!reason) return;

      setSubmitting(true);
      try {
        const res = await fetch("/api/portal/returns/request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ portalToken: token, reason, reasonNotes }),
        });

        if (!res.ok) {
          const body = await res.json();
          throw new Error(body.error || "Failed to submit return request");
        }

        setSubmitted(true);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "An unexpected error occurred");
      } finally {
        setSubmitting(false);
      }
    },
    [token, reason, reasonNotes],
  );

  return (
    <div className="min-h-screen bg-white flex items-start justify-center px-4 py-12">
      <div className="w-full max-w-lg">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-serif text-sh-navy">{storeName}</h1>
          <h2 className="text-lg text-sh-gray mt-1">Return Request</h2>
        </div>

        {loading && <p className="text-center text-sh-gray">Loading return details...</p>}

        {error && (
          <div className="rounded border border-red-200 bg-red-50 p-4 text-center">
            <p className="text-red-800 text-sm">{error}</p>
          </div>
        )}

        {!loading && !error && submitted && (
          <div className="rounded border border-sh-gold/30 bg-sh-linen p-6 text-center">
            <h3 className="text-lg font-serif text-sh-navy mb-2">
              Your return request has been submitted
            </h3>
            {returnInfo && (
              <div className="text-sm text-sh-gray space-y-1 mt-4">
                <p>Return Number: {returnInfo.returnNumber}</p>
                {returnInfo.productName && <p>Product: {returnInfo.productName}</p>}
                <p>Status: {returnInfo.status.replace(/_/g, " ")}</p>
              </div>
            )}
            <p className="text-sm text-sh-gray mt-4">
              You can track your return status at any time using the link provided in your email.
            </p>
          </div>
        )}

        {!loading && !error && !submitted && returnInfo && (
          <form onSubmit={handleSubmit} className="space-y-6">
            {returnInfo.productName && (
              <div className="rounded border border-sh-brand-gray/20 bg-sh-linen p-4">
                <p className="text-sm text-sh-gray">
                  <span className="font-medium text-sh-navy">Product:</span>{" "}
                  {returnInfo.productName}
                </p>
                <p className="text-sm text-sh-gray mt-1">
                  <span className="font-medium text-sh-navy">Qty:</span> {returnInfo.quantity}
                </p>
              </div>
            )}

            <div>
              <label htmlFor="reason" className="block text-sm font-medium text-sh-navy mb-1">
                Reason for return
              </label>
              <select
                id="reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                required
                className="w-full rounded border border-sh-brand-gray/40 bg-white px-3 py-2 text-sm text-sh-black focus:border-sh-navy focus:outline-none focus:ring-1 focus:ring-sh-navy"
              >
                <option value="">Select a reason</option>
                {REASON_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="notes" className="block text-sm font-medium text-sh-navy mb-1">
                Additional notes (optional)
              </label>
              <textarea
                id="notes"
                value={reasonNotes}
                onChange={(e) => setReasonNotes(e.target.value)}
                rows={4}
                className="w-full rounded border border-sh-brand-gray/40 bg-white px-3 py-2 text-sm text-sh-black focus:border-sh-navy focus:outline-none focus:ring-1 focus:ring-sh-navy resize-none"
                placeholder="Please describe the issue in detail..."
              />
            </div>

            <button
              type="submit"
              disabled={submitting || !reason}
              className="w-full rounded bg-sh-navy px-4 py-3 text-sm font-medium text-white hover:bg-sh-navy/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {submitting ? "Submitting..." : "Submit Return Request"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
