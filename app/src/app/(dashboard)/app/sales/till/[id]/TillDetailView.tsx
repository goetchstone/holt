"use client";

// /app/src/app/(dashboard)/app/sales/till/[id]/TillDetailView.tsx
//
// Till detail body -- App Router port of the legacy sales/till/[id] (minus
// MainLayout chrome, which the (dashboard) layout supplies). Staff/timing,
// financials, denomination counts, payments, and the manager reconcile action
// all read/write the shared /api/tills/:id REST endpoints exactly as before.
// The id arrives as a prop from the server page (params awaited there). Money
// is shown via useMoneyFormatter (till precision shows cents).

import { useState, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";
import axios from "axios";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { getErrorMessage } from "@/lib/toastError";

interface TillPayment {
  id: number;
  paymentDate: string;
  paymentAmount: number;
  method: string;
  isRefund: boolean;
  salesOrder: { orderno: string } | null;
}

interface TillCount {
  denomination: string;
  quantity: number;
  amount: number;
  isOpening: boolean;
}

interface TillDetail {
  id: number;
  status: string;
  openedAt: string;
  closedAt: string | null;
  openingCash: number;
  expectedCash: number | null;
  actualCash: number | null;
  variance: number | null;
  notes: string | null;
  register: { name: string; storeLocation: { name: string } };
  openedBy: { displayName: string };
  closedBy: { displayName: string } | null;
  payments: TillPayment[];
  counts: TillCount[];
}

type MoneyFmt = ReturnType<typeof useMoneyFormatter>;

const STATUS_STYLES: Record<string, string> = {
  OPEN: "bg-green-50 text-green-700",
  CLOSED: "bg-yellow-50 text-yellow-700",
  RECONCILED: "bg-blue-50 text-blue-700",
};

const METHOD_LABELS: Record<string, string> = {
  CASH: "Cash",
  CARD: "Card",
  CHECK: "Check",
  GIFT_CARD: "Gift Card",
  STORE_CREDIT: "Store Credit",
  OTHER: "Other",
};

// Variance is green at exactly zero, red otherwise, gray when not yet known.
// Extracted so the JSX below stays free of nested ternaries (S3358).
function varianceClass(variance: number | null): string {
  if (variance == null) return "text-sh-gray";
  return variance === 0 ? "text-green-600" : "text-red-600";
}

function fmtDate(d: string | null): string {
  if (!d) return "--";
  return new Date(d).toLocaleString();
}

// ── Denomination count section ─────────────────────────────────────────────────

function DenominationCountSection({
  phase,
  rows,
  fmt,
}: Readonly<{ phase: "opening" | "closing"; rows: TillCount[]; fmt: MoneyFmt }>) {
  const phaseTotal = rows.reduce((sum, r) => sum + r.amount, 0);
  return (
    <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-6">
      <h2 className="text-lg font-semibold text-sh-black mb-4">
        {phase === "opening" ? "Opening" : "Closing"} Denomination Counts
      </h2>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-sh-gray border-b border-sh-gray/10">
            <th className="py-2 font-medium">Denomination</th>
            <th className="py-2 font-medium text-right">Quantity</th>
            <th className="py-2 font-medium text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.denomination} className="border-b border-sh-gray/5">
              <td className="py-2 text-sh-black">{c.denomination}</td>
              <td className="py-2 text-right text-sh-gray">{c.quantity}</td>
              <td className="py-2 text-right text-sh-black">{fmt(c.amount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-sh-gray/20">
            <td className="py-3 font-semibold text-sh-black" colSpan={2}>
              Total
            </td>
            <td className="py-3 text-right font-semibold text-sh-black">{fmt(phaseTotal)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ── Payments table ─────────────────────────────────────────────────────────────

function PaymentsTable({ payments, fmt }: Readonly<{ payments: TillPayment[]; fmt: MoneyFmt }>) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-sh-gray border-b border-sh-gray/10">
            <th className="py-2 pr-4 font-medium">Date</th>
            <th className="py-2 pr-4 font-medium">Order #</th>
            <th className="py-2 pr-4 font-medium">Method</th>
            <th className="py-2 font-medium text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {payments.map((p) => (
            <tr key={p.id} className="border-b border-sh-gray/5">
              <td className="py-2 pr-4 text-sh-gray">{new Date(p.paymentDate).toLocaleString()}</td>
              <td className="py-2 pr-4 text-sh-black">{p.salesOrder?.orderno || "--"}</td>
              <td className="py-2 pr-4">
                <span className="text-sh-black">{METHOD_LABELS[p.method] || p.method}</span>
                {p.isRefund && (
                  <span className="ml-1 text-xs px-1 py-0.5 rounded bg-red-50 text-red-600">
                    Refund
                  </span>
                )}
              </td>
              <td
                className={`py-2 text-right font-medium ${p.isRefund ? "text-red-600" : "text-sh-black"}`}
              >
                {p.isRefund ? "-" : ""}
                {fmt(p.paymentAmount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function TillDetailView({ id }: Readonly<{ id: string }>) {
  const { data: session } = useSession();
  const userRole = (session as { role?: string } | null)?.role || "DESIGNER";
  const isManager = userRole === "MANAGER" || userRole === "ADMIN" || userRole === "SUPER_ADMIN";
  const fmt = useMoneyFormatter();

  const [till, setTill] = useState<TillDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [reconcileNotes, setReconcileNotes] = useState("");
  const [showReconcile, setShowReconcile] = useState(false);
  const [saving, setSaving] = useState(false);

  const fetchTill = useCallback(async () => {
    if (!id) return;
    try {
      const res = await axios.get(`/api/tills/${encodeURIComponent(id)}`);
      setTill(res.data);
    } catch {
      toast.error("Failed to load till");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchTill();
  }, [fetchTill]);

  const handleReconcile = async () => {
    if (!till) return;
    setSaving(true);
    try {
      await axios.post(`/api/tills/${till.id}/reconcile`, {
        notes: reconcileNotes || undefined,
      });
      toast.success("Till reconciled");
      setShowReconcile(false);
      fetchTill();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to reconcile till"));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <p className="text-sh-gray font-serif py-4">Loading...</p>;
  }

  if (!till) {
    return <p className="text-sh-gray font-serif py-4">Till not found.</p>;
  }

  const openingRows = till.counts.filter((c) => c.isOpening);
  const closingRows = till.counts.filter((c) => !c.isOpening);
  const canReconcile = till.status === "CLOSED" && isManager;

  return (
    <div className="py-2 space-y-6 font-serif">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl text-sh-blue font-semibold">{till.register.name}</h1>
          <p className="text-sm text-sh-gray mt-1">{till.register.storeLocation.name}</p>
        </div>
        <span
          className={`text-xs px-2 py-0.5 rounded ${STATUS_STYLES[till.status] || "bg-sh-gray/10 text-sh-gray"}`}
        >
          {till.status}
        </span>
      </div>

      {/* Staff and timing */}
      <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-6">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
          <div>
            <p className="text-sh-gray">Opened By</p>
            <p className="text-sh-black font-medium">{till.openedBy.displayName}</p>
          </div>
          <div>
            <p className="text-sh-gray">Opened At</p>
            <p className="text-sh-black">{fmtDate(till.openedAt)}</p>
          </div>
          <div>
            <p className="text-sh-gray">Closed By</p>
            <p className="text-sh-black font-medium">{till.closedBy?.displayName || "--"}</p>
          </div>
          <div>
            <p className="text-sh-gray">Closed At</p>
            <p className="text-sh-black">{fmtDate(till.closedAt)}</p>
          </div>
        </div>
      </div>

      {/* Financials */}
      <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-6">
        <h2 className="text-lg font-semibold text-sh-black mb-4">Financials</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
          <div>
            <p className="text-sh-gray">Opening Cash</p>
            <p className="text-sh-black font-medium">{fmt(till.openingCash)}</p>
          </div>
          <div>
            <p className="text-sh-gray">Expected Cash</p>
            <p className="text-sh-black font-medium">{fmt(till.expectedCash)}</p>
          </div>
          <div>
            <p className="text-sh-gray">Actual Cash</p>
            <p className="text-sh-black font-medium">{fmt(till.actualCash)}</p>
          </div>
          <div>
            <p className="text-sh-gray">Variance</p>
            <p className={`font-medium ${varianceClass(till.variance)}`}>{fmt(till.variance)}</p>
          </div>
        </div>
      </div>

      {/* Denomination counts -- split by open vs close */}
      {openingRows.length > 0 && (
        <DenominationCountSection phase="opening" rows={openingRows} fmt={fmt} />
      )}
      {closingRows.length > 0 && (
        <DenominationCountSection phase="closing" rows={closingRows} fmt={fmt} />
      )}

      {/* Payments */}
      <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-6">
        <h2 className="text-lg font-semibold text-sh-black mb-4">
          Payments ({till.payments.length})
        </h2>
        {till.payments.length === 0 ? (
          <p className="text-sm text-sh-gray">No payments recorded on this till.</p>
        ) : (
          <PaymentsTable payments={till.payments} fmt={fmt} />
        )}
      </div>

      {/* Notes */}
      {till.notes && (
        <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-6">
          <h2 className="text-lg font-semibold text-sh-black mb-2">Notes</h2>
          <p className="text-sm text-sh-gray whitespace-pre-wrap">{till.notes}</p>
        </div>
      )}

      {/* Reconcile action for managers */}
      {canReconcile && (
        <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-6">
          {!showReconcile ? (
            <Button size="sm" onClick={() => setShowReconcile(true)}>
              Reconcile
            </Button>
          ) : (
            <div className="space-y-3">
              <h2 className="text-lg font-semibold text-sh-black">Reconcile Till</h2>
              <div>
                <label htmlFor="reconcile-notes" className="block text-sm text-sh-gray mb-1">
                  Reconciliation Notes
                </label>
                <textarea
                  id="reconcile-notes"
                  value={reconcileNotes}
                  onChange={(e) => setReconcileNotes(e.target.value)}
                  className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
                  rows={3}
                  placeholder="Optional notes..."
                />
              </div>
              <div className="flex gap-3">
                <Button onClick={handleReconcile} disabled={saving}>
                  {saving ? "Reconciling..." : "Confirm Reconcile"}
                </Button>
                <Button variant="outline" onClick={() => setShowReconcile(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
