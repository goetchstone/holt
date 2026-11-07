"use client";

// /app/src/app/(dashboard)/app/sales/orders/[id]/CancelOrderModal.tsx
//
// Cancelling a sale: it says what's on it, and asks where the money goes
// (lib/sales/cancelOrder.ts). The order doesn't cancel until that's done.

import { useEffect, useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import Modal from "@/components/ui/Modal";
import { getErrorMessage } from "@/lib/toastError";
import type { CancelPlan, CancelResult } from "@/lib/sales/cancelOrder";
import type { RefundDestination } from "@/lib/returns/refundReturn";
import type { SalePo } from "@/lib/sales/salePos";
import type { PoDecision } from "@/lib/sales/salePosShared";

/** What happens to one PO, and the choice when the vendor has acknowledged it. */
function PoChoice({
  po,
  decision,
  onDecide,
}: Readonly<{
  po: SalePo;
  decision: PoDecision | undefined;
  onDecide: (decision: PoDecision) => void;
}>) {
  if (po.standing === "OPEN") {
    return (
      <p className="text-sm text-brand-gray">
        {po.poNumber} for {po.vendor} will be cancelled.
        {po.sentToVendor && ` It has gone to them, so let them know.`}
      </p>
    );
  }
  if (po.standing === "HERE") {
    return (
      <p className="text-sm text-brand-gray">
        {po.poNumber} has arrived, so the piece goes back to stock to sell off the floor.
      </p>
    );
  }
  if (po.standing !== "ACKNOWLEDGED") return null;
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">
        {po.vendor} has acknowledged {po.poNumber}. What happens to it?
      </legend>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="radio"
          name={`po-${po.id}`}
          className="mt-1"
          checked={decision === "VENDOR_AGREED"}
          onChange={() => onDecide("VENDOR_AGREED")}
        />
        <span>They agreed to cancel it, so cancel the PO</span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="radio"
          name={`po-${po.id}`}
          className="mt-1"
          checked={decision === "KEEP_THE_PIECE"}
          onChange={() => onDecide("KEEP_THE_PIECE")}
        />
        <span>Keep the piece: it arrives as stock to sell off the floor</span>
      </label>
    </fieldset>
  );
}

export function CancelOrderModal({
  orderId,
  orderno,
  isQuote,
  formatCurrency,
  onClose,
  onCancelled,
}: Readonly<{
  orderId: string;
  orderno: string;
  isQuote: boolean;
  formatCurrency: (value: number) => string;
  onClose: () => void;
  onCancelled: () => void;
}>) {
  const [money, setMoney] = useState<
    (CancelPlan & { canRefund: boolean; canCallPo: boolean }) | null
  >(null);
  const [poDecisions, setPoDecisions] = useState<Record<number, PoDecision>>({});
  const [destination, setDestination] = useState<RefundDestination>("ORIGINAL_PAYMENT");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const what = isQuote ? "quote" : "order";

  useEffect(() => {
    axios
      .get(`/api/sales/orders/${encodeURIComponent(orderId)}/cancel`)
      .then((res) => setMoney(res.data))
      .catch((err: unknown) => toast.error(getErrorMessage(err, `Couldn't read this ${what}.`)));
  }, [orderId, what]);

  const hasMoney = (money?.held ?? 0) > 0;

  const save = async () => {
    if (!money || saving) return;
    if (money.problem) {
      toast.error(money.problem);
      return;
    }
    setSaving(true);
    try {
      const res = await axios.post<CancelResult>(
        `/api/sales/orders/${encodeURIComponent(orderId)}/cancel`,
        { reason, poDecisions, ...(hasMoney ? { destination } : {}) },
      );
      toast.success(`${orderno} cancelled.`);
      for (const { poNumber, vendor } of res.data.tellVendors) {
        toast.info(`${poNumber} is cancelled here. Let ${vendor} know.`, { autoClose: false });
      }
      onCancelled();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, `Couldn't cancel this ${what}.`));
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`Cancel ${what} ${orderno}`}
      onClose={onClose}
      onSave={save}
      saving={saving}
      saveLabel={`Cancel this ${what}`}
      savingLabel="Cancelling..."
      closeLabel={`Keep the ${what}`}
    >
      {money === null ? (
        <p className="text-sm text-brand-gray">Reading what&apos;s on it...</p>
      ) : money.problem ? (
        <p className="text-sm text-red-700">{money.problem}</p>
      ) : (
        <>
          <p className="text-sm text-brand-gray">
            It stays on record as cancelled, its lines and stock go back, and it can&apos;t be
            reopened. To sell it again, copy it.
          </p>
          {money.notices.map((notice) => (
            <p key={notice} className="text-sm text-brand-gray">
              {notice}
            </p>
          ))}
          {money.purchaseOrders.length > 0 &&
            !money.canCallPo &&
            money.purchaseOrders.some((po) => po.standing !== "OPEN") && (
              <p className="text-sm text-red-700">
                A vendor has acknowledged this {what}&apos;s PO, and your role can&apos;t make that
                call. Ask a manager.
              </p>
            )}
          {money.purchaseOrders.map((po) => (
            <PoChoice
              key={po.id}
              po={po}
              decision={poDecisions[po.id]}
              onDecide={(decision) => setPoDecisions((prev) => ({ ...prev, [po.id]: decision }))}
            />
          ))}
          {hasMoney && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">
                {formatCurrency(money.held)} is on this {what}. Where does it go?
              </legend>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="cancel-destination"
                  className="mt-1"
                  checked={destination === "ORIGINAL_PAYMENT"}
                  onChange={() => setDestination("ORIGINAL_PAYMENT")}
                />
                <span>
                  Back the way it was paid
                  <span className="block text-brand-gray">
                    {money.payments.map((p) => `${p.label} ${formatCurrency(p.amount)}`).join(", ")}
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="cancel-destination"
                  className="mt-1"
                  disabled={!money.canCredit}
                  checked={destination === "STORE_CREDIT"}
                  onChange={() => setDestination("STORE_CREDIT")}
                />
                <span>
                  Leave it as credit on the customer&apos;s account
                  {!money.canCredit && (
                    <span className="block text-brand-gray">
                      This {what} has no customer to hold a credit.
                    </span>
                  )}
                </span>
              </label>
              {!money.canRefund && (
                <p className="text-sm text-red-700">
                  Your role can&apos;t give money back. Ask someone who can.
                </p>
              )}
            </fieldset>
          )}
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Why is it being cancelled?</span>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full rounded border border-brand-gray/30 px-3 py-2.5 text-sm"
            />
          </label>
        </>
      )}
    </Modal>
  );
}
