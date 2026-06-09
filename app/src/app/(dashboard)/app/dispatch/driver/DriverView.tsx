"use client";

// /app/src/app/(dashboard)/app/dispatch/driver/DriverView.tsx
//
// Driver delivery view: focused mobile screen for the active delivery run with
// per-stop arrive/complete actions, signature + photo proof capture, and a
// completion summary. App Router port of the legacy pages/dispatch/driver.tsx
// body. The focused warehouse/driver wrapper (full-bleed linen background, no
// dashboard max-width) is PRESERVED via the local DriverLayout. Reads the shared
// /api/dispatch/* REST endpoints.

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import SignatureCapture from "@/components/dispatch/SignatureCapture";
import axios from "axios";
import { toast } from "react-toastify";
import { format } from "date-fns";
import Link from "next/link";
import { Check, MapPin, Phone, Truck } from "lucide-react";

type LineItem = {
  id: number;
  productName: string | null;
  orderedQuantity: number;
};

type Customer = {
  id: number;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
};

type Address = {
  address1: string;
  address2?: string | null;
  city: string;
  state: string;
  zip: string;
};

type ServiceAppointment = {
  id: number;
  appointmentNumber: string;
  accessInstructions: string | null;
  notes: string | null;
  customer: Customer | null;
  address: Address | null;
  salesOrder: {
    id: number;
    orderno: string;
    lineItems: LineItem[];
  } | null;
};

type Stop = {
  id: number;
  stopOrder: number;
  status: string;
  completedAt: string | null;
  recipientName: string | null;
  serviceAppointment: ServiceAppointment;
};

type DeliveryRun = {
  id: number;
  runNumber: string;
  runDate: string;
  status: string;
  vehicle: { id: number; name: string };
  driver: { id: number; displayName: string } | null;
  stops: Stop[];
};

export function DriverView() {
  const [run, setRun] = useState<DeliveryRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [completingStopId, setCompletingStopId] = useState<number | null>(null);
  const [signatureData, setSignatureData] = useState<string | null>(null);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const fetchActiveRun = useCallback(async () => {
    try {
      const today = format(new Date(), "yyyy-MM-dd");
      const res = await axios.get(`/api/dispatch/runs?date=${today}&status=IN_PROGRESS`);
      const runs: DeliveryRun[] = res.data.runs || [];

      if (runs.length === 0) {
        setRun(null);
        return;
      }

      // Fetch the full run detail for the first active run
      const detail = await axios.get(`/api/dispatch/runs/${runs[0].id}`);
      setRun(detail.data);
    } catch {
      toast.error("Failed to load delivery run");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchActiveRun();
  }, [fetchActiveRun]);

  async function markArrived(stopId: number) {
    try {
      await axios.put(`/api/dispatch/stops/${stopId}`, { status: "ARRIVED" });
      toast.success("Marked as arrived");
      fetchActiveRun();
    } catch {
      toast.error("Failed to update stop");
    }
  }

  function startCompletion(stopId: number) {
    setCompletingStopId(stopId);
    setSignatureData(null);
    setPhotoFile(null);
  }

  async function submitProofAndComplete(stopId: number) {
    if (!signatureData && !photoFile) {
      toast.error("Capture a signature or photo before completing");
      return;
    }

    setSubmitting(true);
    try {
      // Upload proof
      const formData = new FormData();
      if (signatureData) {
        formData.append("signature", signatureData);
      }
      if (photoFile) {
        formData.append("photo", photoFile);
      }

      await axios.post(`/api/dispatch/stops/${stopId}/proof`, formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });

      // Mark completed
      await axios.put(`/api/dispatch/stops/${stopId}`, { status: "COMPLETED" });

      toast.success("Delivery completed");
      setCompletingStopId(null);
      setSignatureData(null);
      setPhotoFile(null);
      fetchActiveRun();
    } catch {
      toast.error("Failed to complete delivery");
    } finally {
      setSubmitting(false);
    }
  }

  async function completeRun() {
    if (!run) return;
    try {
      await axios.put(`/api/dispatch/runs/${run.id}/status`, { status: "COMPLETED" });
      toast.success("Run completed");
      setRun(null);
    } catch {
      toast.error("Failed to complete run");
    }
  }

  const completedCount = run?.stops.filter((s) => s.status === "COMPLETED").length ?? 0;
  const totalStops = run?.stops.length ?? 0;
  const allCompleted = run ? completedCount === totalStops && totalStops > 0 : false;

  // Find the next incomplete stop
  const nextStopId = run?.stops.find((s) => s.status !== "COMPLETED" && s.status !== "FAILED")?.id;

  if (loading) {
    return (
      <DriverLayout>
        <div className="text-center py-12 text-sh-gray">Loading...</div>
      </DriverLayout>
    );
  }

  if (!run) {
    return (
      <DriverLayout>
        <div className="text-center py-16 px-6">
          <Truck className="w-12 h-12 text-sh-gray/40 mx-auto mb-4" />
          <p className="text-sh-gray text-lg mb-6">No active delivery run</p>
          <Link
            href="/app/dispatch"
            className="text-sh-blue hover:underline min-h-[60px] inline-flex items-center text-base"
          >
            Back to Dispatch Board
          </Link>
        </div>
      </DriverLayout>
    );
  }

  // Summary screen when all stops completed
  if (allCompleted) {
    return (
      <DriverLayout>
        <div className="px-4 py-6">
          <div className="text-center py-12">
            <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
              <Check className="w-8 h-8 text-green-600" />
            </div>
            <h2 className="font-serif text-xl text-sh-navy mb-2">All Deliveries Complete</h2>
            <p className="text-sh-gray mb-2">{totalStops} stops completed</p>
            <p className="text-sh-gray text-sm mb-8">Return to base</p>
            <Button
              fullWidth
              onClick={completeRun}
              className="min-h-[60px] text-base bg-green-600 hover:bg-green-700"
            >
              Complete Run
            </Button>
          </div>
        </div>
      </DriverLayout>
    );
  }

  return (
    <DriverLayout>
      {/* Header */}
      <div className="px-4 py-3 bg-white border-b border-sh-gray/10">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="font-serif text-lg text-sh-navy">{run.runNumber}</h1>
            <p className="text-xs text-sh-gray">{run.vehicle.name}</p>
          </div>
          <div className="text-right">
            <span className="text-sm font-semibold text-sh-navy">
              {completedCount} of {totalStops}
            </span>
            <p className="text-xs text-sh-gray">completed</p>
          </div>
        </div>

        {/* Progress bar */}
        <div className="mt-2 h-2 bg-sh-stripe rounded-full overflow-hidden">
          <div
            className="h-full bg-sh-gold rounded-full transition-all"
            style={{ width: totalStops > 0 ? `${(completedCount / totalStops) * 100}%` : "0%" }}
          />
        </div>
      </div>

      {/* Stop list */}
      <div className="px-4 py-4 space-y-4">
        {run.stops.map((stop) => {
          const appt = stop.serviceAppointment;
          const customerName = appt.customer
            ? `${appt.customer.firstName || ""} ${appt.customer.lastName || ""}`.trim()
            : "Unknown Customer";

          const isNext = stop.id === nextStopId;
          const isCompleting = stop.id === completingStopId;
          const fullAddress = appt.address
            ? [
                appt.address.address1,
                appt.address.address2,
                `${appt.address.city}, ${appt.address.state} ${appt.address.zip}`,
              ]
                .filter(Boolean)
                .join(", ")
            : null;

          const encodedAddress = fullAddress ? encodeURIComponent(fullAddress) : null;

          return (
            <div
              key={stop.id}
              className={`bg-white rounded-lg border p-4 ${
                isNext && stop.status !== "COMPLETED"
                  ? "border-sh-blue border-2 shadow-md"
                  : stop.status === "COMPLETED"
                    ? "border-green-200 bg-green-50/30"
                    : "border-sh-gray/10"
              }`}
            >
              {/* Stop header */}
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span
                    className={`text-sm font-semibold w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
                      stop.status === "COMPLETED"
                        ? "bg-green-100 text-green-700"
                        : "bg-sh-blue text-white"
                    }`}
                  >
                    {stop.status === "COMPLETED" ? <Check className="w-4 h-4" /> : stop.stopOrder}
                  </span>
                  <StopStatusBadge status={stop.status} />
                </div>
              </div>

              {/* Customer name */}
              <h3 className="text-lg font-semibold text-sh-navy mb-1">{customerName}</h3>

              {/* Address as map link */}
              {fullAddress && encodedAddress && (
                <a
                  href={`https://maps.apple.com/?daddr=${encodedAddress}`}
                  className="flex items-start gap-2 text-sm text-sh-blue hover:underline mb-2 min-h-[44px]"
                >
                  <MapPin className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>{fullAddress}</span>
                </a>
              )}

              {/* Phone */}
              {appt.customer?.phone && (
                <a
                  href={`tel:${appt.customer.phone}`}
                  className="flex items-center gap-2 text-sm text-sh-blue hover:underline mb-2 min-h-[44px]"
                >
                  <Phone className="w-4 h-4 shrink-0" />
                  <span>{appt.customer.phone}</span>
                </a>
              )}

              {/* Items */}
              {appt.salesOrder && appt.salesOrder.lineItems.length > 0 && (
                <div className="mt-2 bg-sh-linen rounded-lg p-3">
                  <p className="text-xs font-semibold text-sh-gray uppercase tracking-wide mb-1">
                    Items
                  </p>
                  {appt.salesOrder.lineItems.map((li) => (
                    <div key={li.id} className="text-sm text-sh-navy">
                      {li.productName || "Unnamed item"}
                      {Number(li.orderedQuantity) > 1 && (
                        <span className="text-sh-gray ml-1">x{Number(li.orderedQuantity)}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Access instructions */}
              {appt.accessInstructions && (
                <div className="mt-2 text-sm text-sh-gray">
                  <span className="font-semibold">Access: </span>
                  {appt.accessInstructions}
                </div>
              )}

              {/* Notes */}
              {appt.notes && (
                <div className="mt-1 text-sm text-sh-gray">
                  <span className="font-semibold">Notes: </span>
                  {appt.notes}
                </div>
              )}

              {/* Actions */}
              <div className="mt-4">
                {stop.status === "PENDING" && (
                  <button
                    onClick={() => markArrived(stop.id)}
                    className="w-full min-h-[60px] bg-sh-blue text-white font-serif font-semibold text-base rounded-lg shadow-md hover:bg-sh-black transition"
                  >
                    Mark Arrived
                  </button>
                )}

                {stop.status === "ARRIVED" && !isCompleting && (
                  <button
                    onClick={() => startCompletion(stop.id)}
                    className="w-full min-h-[60px] bg-green-600 text-white font-serif font-semibold text-base rounded-lg shadow-md hover:bg-green-700 transition"
                  >
                    Complete Delivery
                  </button>
                )}

                {isCompleting && (
                  <div className="space-y-4 border-t border-sh-gray/10 pt-4">
                    <SignatureCapture
                      onSave={(data) => setSignatureData(data)}
                      width={600}
                      height={200}
                    />

                    {signatureData && (
                      <p className="text-sm text-green-600 font-semibold">Signature captured</p>
                    )}

                    <div>
                      <label className="block text-sm text-sh-gray mb-1">Photo (optional)</label>
                      <input
                        type="file"
                        accept="image/*"
                        capture="environment"
                        onChange={(e) => {
                          const file = e.target.files?.[0] || null;
                          setPhotoFile(file);
                        }}
                        className="block w-full text-sm text-sh-gray min-h-[44px]"
                      />
                    </div>

                    <button
                      onClick={() => submitProofAndComplete(stop.id)}
                      disabled={submitting || (!signatureData && !photoFile)}
                      className="w-full min-h-[60px] bg-green-600 text-white font-serif font-semibold text-base rounded-lg shadow-md hover:bg-green-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {submitting ? "Submitting..." : "Submit and Complete"}
                    </button>
                  </div>
                )}

                {stop.status === "COMPLETED" && (
                  <div className="flex items-center gap-2 text-sm text-green-600">
                    <Check className="w-4 h-4" />
                    <span>
                      Completed
                      {stop.completedAt && (
                        <span className="text-sh-gray ml-1">
                          at {format(new Date(stop.completedAt), "h:mm a")}
                        </span>
                      )}
                      {stop.recipientName && (
                        <span className="text-sh-gray ml-1">- {stop.recipientName}</span>
                      )}
                    </span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </DriverLayout>
  );
}

function DriverLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-sh-linen" style={{ minWidth: 375 }}>
      {children}
    </div>
  );
}

function StopStatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    PENDING: "bg-sh-stripe text-sh-gray",
    EN_ROUTE: "bg-sh-blue/10 text-sh-blue",
    ARRIVED: "bg-sh-gold/10 text-sh-gold",
    COMPLETED: "bg-green-50 text-green-700",
    FAILED: "bg-red-50 text-red-600",
  };

  return (
    <span
      className={`text-xs px-2 py-0.5 rounded-full ${colors[status] || "bg-sh-stripe text-sh-gray"}`}
    >
      {status.replace("_", " ")}
    </span>
  );
}
