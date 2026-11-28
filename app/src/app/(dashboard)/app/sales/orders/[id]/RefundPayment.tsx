"use client";

// /app/src/app/(dashboard)/app/sales/orders/[id]/RefundPayment.tsx
//
// Refund one of the order's payments, in full or in part, the way it was
// taken: a card paid through the processor goes back through it, cash comes out
// of the till at this browser's register, a gift card or store credit goes back
// where it came from, anything else is recorded for the store to hand back.
//
// Posts to orders/[id]/refunds.ts (payment.refund), which no screen called
// until 2026-11-28. The server decides everything that matters: the amount left
// to refund, under its lock; the till being open; the gift card rules. This
// offers the action, says where the money goes, and shows the server's own
// words when it refuses (rule 11).

import { useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import Modal from "@/components/ui/Modal";
import { getErrorMessage } from "@/lib/toastError";
import { rememberedRegisterId } from "@/lib/pos/registerChoice";
import {
  refundAmountProblem,
  refundGoesTo,
  refundNeedsTill,
  type RefundablePayment,
} from "@/lib/sales/refundPaymentShared";

/** The open till at the register this browser works at, if there is one. */
async function openTillHere(): Promise<{ registerId: number; tillId: number } | null> {
  const registerId = rememberedRegisterId();
  if (registerId === null) return null;
  try {
    const res = await axios.get<{ openTillId?: number | null }>(`/api/registers/${registerId}`);
    return res.data.openTillId ? { registerId, tillId: res.data.openTillId } : null;
  } catch {
    // Not allowed to read registers, or it is gone: no till to book against.
    return null;
  }
}

export function RefundPayment({
  orderId,
  payment,
  formatCurrency,
  onRefunded,
}: Readonly<{
  orderId: number;
  payment: RefundablePayment;
  formatCurrency: (n: number) => string;
  onRefunded: () => void;
}>) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  if (payment.refundable <= 0) return null;

  const start = () => {
    setAmount(payment.refundable.toFixed(2));
    setReason("");
    setOpen(true);
  };

  const refund = async () => {
    const problem = refundAmountProblem(amount, payment.refundable, formatCurrency);
    if (problem) {
      toast.error(problem);
      return;
    }
    if (!reason.trim()) {
      toast.error("Say why, for the order's history.");
      return;
    }
    setBusy(true);
    try {
      const till = await openTillHere();
      if (refundNeedsTill(payment.method) && !till) {
        toast.error(
          "A cash refund comes out of a till. Choose your register on the register screen " +
            "and open its till, then refund.",
        );
        return;
      }
      await axios.post(`/api/sales/orders/${orderId}/refunds`, {
        paymentId: payment.id,
        amount: Number(amount),
        reason: reason.trim(),
        registerId: till?.registerId,
        tillId: till?.tillId,
      });
      toast.success(`${formatCurrency(Number(amount))} refunded.`);
      setOpen(false);
      onRefunded();
    } catch (err) {
      toast.error(getErrorMessage(err, "The refund was not made."));
      // It may have changed meanwhile (another refund, a closed till): show what it is now.
      onRefunded();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button onClick={start} className="text-xs text-red-600 hover:underline">
        Refund
      </button>
      {open && (
        <Modal
          title={`Refund ${payment.paymentType} payment`}
          onClose={() => setOpen(false)}
          onSave={() => void refund()}
          saving={busy}
          saveLabel="Refund"
          savingLabel="Refunding..."
          closeLabel="Keep the payment"
        >
          <p className="text-sm text-brand-gray">
            {formatCurrency(payment.refundable)} is left to refund on this payment.{" "}
            {refundGoesTo(payment)}
          </p>
          <label className="block text-sm">
            <span className="mb-1 block text-brand-gray">Amount to refund</span>
            <input
              type="number"
              step="0.01"
              min="0.01"
              max={payment.refundable}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-40 rounded-md border border-brand-accent-gray px-3 py-2 text-right"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-brand-gray">Why</span>
            <input
              type="text"
              value={reason}
              maxLength={200}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Shown in the order's history"
              className="w-full rounded-md border border-brand-accent-gray px-3 py-2"
            />
          </label>
        </Modal>
      )}
    </>
  );
}

/** A payment as the order route lists it, as far as its actions need. */
interface ListedPayment {
  id: number;
  paymentType: string;
  status: string | null;
  method?: string | null;
  viaProcessor?: boolean;
  refundable?: number;
}

/**
 * What can be done to one of the order's payments, in its row: void it while it
 * is pending, refund it once it is completed. Each is offered to the holders of
 * its own key, and Refund shows itself only when something is left to refund.
 */
export function PaymentActions({
  orderId,
  payment,
  canVoid,
  canRefund,
  onVoid,
  formatCurrency,
  onRefunded,
}: Readonly<{
  orderId: number;
  payment: ListedPayment;
  canVoid: boolean;
  canRefund: boolean;
  onVoid: () => void;
  formatCurrency: (n: number) => string;
  onRefunded: () => void;
}>) {
  return (
    <>
      {canVoid && payment.status === "PENDING" && (
        <button onClick={onVoid} className="text-xs text-red-600 hover:underline">
          Void
        </button>
      )}
      {canRefund && (
        <RefundPayment
          orderId={orderId}
          payment={{
            id: payment.id,
            paymentType: payment.paymentType,
            method: payment.method ?? null,
            refundable: payment.refundable ?? 0,
            viaProcessor: payment.viaProcessor === true,
          }}
          formatCurrency={formatCurrency}
          onRefunded={onRefunded}
        />
      )}
    </>
  );
}
