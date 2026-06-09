"use client";

// /app/src/app/portal/return/status/[token]/ReturnStatusView.tsx
//
// Public customer return-status tracker: shows the return summary and a
// step-by-step progress list. App Router port of
// pages/portal/return/status/[token].tsx (customer-facing chrome kept local --
// portal must NOT show staff nav). The token arrives as a prop from the server
// page. Hits the public /api/portal/returns/* REST endpoint exactly as before.

import { useState, useEffect } from "react";
import { useBranding } from "@/components/branding/BrandingProvider";

interface ReturnInfo {
  returnNumber: string;
  status: string;
  reason: string;
  productName: string | null;
  quantity: number;
  created: string;
  customerNotes: string | null;
}

const PROGRESS_STEPS = [
  { key: "SUBMITTED", label: "Submitted" },
  { key: "RECEIVED", label: "Received" },
  { key: "INSPECTED", label: "Inspected" },
  { key: "COMPLETE", label: "Complete" },
];

// Maps return statuses to which progress steps are considered complete
const STATUS_TO_COMPLETED_STEPS: Record<string, string[]> = {
  INITIATED: ["SUBMITTED"],
  PICKUP_SCHEDULED: ["SUBMITTED"],
  PICKUP_COMPLETED: ["SUBMITTED"],
  RECEIVED: ["SUBMITTED", "RECEIVED"],
  INSPECTED: ["SUBMITTED", "RECEIVED", "INSPECTED"],
  RESTOCKED: ["SUBMITTED", "RECEIVED", "INSPECTED", "COMPLETE"],
  WRITTEN_OFF: ["SUBMITTED", "RECEIVED", "INSPECTED", "COMPLETE"],
  CLOSED: ["SUBMITTED", "RECEIVED", "INSPECTED", "COMPLETE"],
  CANCELLED: ["SUBMITTED"],
};

const STATUS_LABELS: Record<string, string> = {
  INITIATED: "Submitted",
  PICKUP_SCHEDULED: "Pickup Scheduled",
  PICKUP_COMPLETED: "Pickup Completed",
  RECEIVED: "Received at Warehouse",
  INSPECTED: "Inspection Complete",
  RESTOCKED: "Restocked",
  WRITTEN_OFF: "Written Off",
  CLOSED: "Closed",
  CANCELLED: "Cancelled",
};

export function ReturnStatusView({ token }: { token: string }) {
  const branding = useBranding();
  const storeName = branding.companyName ?? branding.appName;

  const [returnInfo, setReturnInfo] = useState<ReturnInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;

    fetch(`/api/portal/returns/${encodeURIComponent(token)}`)
      .then((res) => {
        if (!res.ok) throw new Error("Invalid or expired return link");
        return res.json();
      })
      .then((data) => setReturnInfo(data))
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Invalid or expired return link"),
      )
      .finally(() => setLoading(false));
  }, [token]);

  const completedSteps = returnInfo ? STATUS_TO_COMPLETED_STEPS[returnInfo.status] || [] : [];
  const isCancelled = returnInfo?.status === "CANCELLED";

  return (
    <div className="min-h-screen bg-white flex items-start justify-center px-4 py-12">
      <div className="w-full max-w-lg">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-serif text-sh-navy">{storeName}</h1>
          <h2 className="text-lg text-sh-gray mt-1">Return Status</h2>
        </div>

        {loading && <p className="text-center text-sh-gray">Loading return details...</p>}

        {error && (
          <div className="rounded border border-red-200 bg-red-50 p-4 text-center">
            <p className="text-red-800 text-sm">{error}</p>
          </div>
        )}

        {!loading && !error && returnInfo && (
          <div className="space-y-6">
            <div className="rounded border border-sh-brand-gray/20 bg-sh-linen p-4 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-sh-gray">Return Number</span>
                <span className="font-medium text-sh-navy">{returnInfo.returnNumber}</span>
              </div>
              {returnInfo.productName && (
                <div className="flex justify-between text-sm">
                  <span className="text-sh-gray">Product</span>
                  <span className="font-medium text-sh-navy">{returnInfo.productName}</span>
                </div>
              )}
              <div className="flex justify-between text-sm">
                <span className="text-sh-gray">Status</span>
                <span className="font-medium text-sh-navy">
                  {STATUS_LABELS[returnInfo.status] || returnInfo.status}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-sh-gray">Date Submitted</span>
                <span className="font-medium text-sh-navy">
                  {new Date(returnInfo.created).toLocaleDateString("en-US", {
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                  })}
                </span>
              </div>
            </div>

            {isCancelled ? (
              <div className="rounded border border-red-200 bg-red-50 p-4 text-center">
                <p className="text-red-800 text-sm font-medium">This return has been cancelled.</p>
              </div>
            ) : (
              <div className="space-y-3">
                <h3 className="text-sm font-medium text-sh-navy">Progress</h3>
                <ul className="space-y-2">
                  {PROGRESS_STEPS.map((step) => {
                    const done = completedSteps.includes(step.key);
                    return (
                      <li key={step.key} className="flex items-center gap-3 text-sm">
                        <span
                          className={`flex h-5 w-5 items-center justify-center rounded-full text-xs ${
                            done
                              ? "bg-sh-navy text-white"
                              : "border border-sh-brand-gray/40 text-sh-brand-gray"
                          }`}
                        >
                          {done ? "✓" : ""}
                        </span>
                        <span className={done ? "text-sh-navy font-medium" : "text-sh-gray"}>
                          {step.label}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
