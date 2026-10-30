"use client";

// GAP-09: the order's delivery fee, on the order screen. Shows what the order
// charges and what its zone would charge for its address and pieces, and lets
// staff charge, change or remove the fee while the order is still open
// (orders/[id]/delivery-fee.ts). The fee line itself is left out of the line
// edits: it changes only here, which keeps its tax right.

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { getErrorMessage } from "@/lib/toastError";
import type { OrderDeliveryFee } from "@/lib/delivery/deliveryFeeShared";
import { useDiscountApproval } from "@/components/sales/useDiscountApproval";

interface Props {
  orderId: number;
  deliveryMethod: string | null;
  editable: boolean;
  /** Changes whenever the order's lines do, so the zone's fee is priced again. */
  linesKey: string;
  formatCurrency: (n: number) => string;
  onChanged: () => void;
}

export function DeliveryFeePanel({
  orderId,
  deliveryMethod,
  editable,
  linesKey,
  formatCurrency,
  onChanged,
}: Readonly<Props>) {
  const [fee, setFee] = useState<OrderDeliveryFee | null>(null);
  const [amount, setAmount] = useState("");
  const [saving, setSaving] = useState(false);
  const { send: sendWithApproval, modal: approvalModal } = useDiscountApproval();
  const url = `/api/sales/orders/${encodeURIComponent(String(orderId))}/delivery-fee`;

  const show = useCallback((data: OrderDeliveryFee) => {
    setFee(data);
    setAmount(data.current ? data.current.amount.toFixed(2) : "");
  }, []);

  useEffect(() => {
    let cancelled = false;
    axios
      .get<OrderDeliveryFee>(url)
      .then((res) => {
        if (!cancelled) show(res.data);
      })
      .catch((err: unknown) => {
        if (!cancelled) toast.error(getErrorMessage(err, "Failed to load the delivery fee"));
      });
    return () => {
      cancelled = true;
    };
  }, [url, linesKey, show]);

  const save = async (next: number | null) => {
    setSaving(true);
    try {
      // A fee below the zone's on a delivery order is a discount: past what
      // this person may give, it asks for a manager's PIN (GAP-06).
      const res = await sendWithApproval((discountApproval) =>
        axios.put<OrderDeliveryFee>(url, { amount: next, discountApproval }),
      );
      if (!res) return;
      show(res.data);
      toast.success(next ? "Delivery fee saved" : "Delivery fee removed");
      onChanged();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to save the delivery fee"));
    } finally {
      setSaving(false);
    }
  };

  if (!fee) return null;
  const { current, quote } = fee;
  if (deliveryMethod !== "DELIVERY" && !current) return null;

  const typed = Number.parseFloat(amount);
  const changed = (Number.isFinite(typed) ? typed : 0) !== (current?.amount ?? 0);

  return (
    <div className="mt-2 rounded border border-brand-gray/20 p-2">
      {approvalModal}
      <p>
        <strong>Delivery fee:</strong>{" "}
        {current
          ? `${formatCurrency(current.amount)} (tax ${formatCurrency(current.taxAmount)})`
          : "None"}
      </p>
      <p className="text-xs text-brand-gray">
        <ZoneNote fee={fee} formatCurrency={formatCurrency} />
      </p>
      {current && deliveryMethod !== "DELIVERY" && (
        <p className="text-xs text-amber-700">
          This order charges delivery but its conveyance isn&apos;t Delivery.
        </p>
      )}
      {editable && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label htmlFor="order-delivery-fee" className="sr-only">
            Delivery fee
          </label>
          <input
            id="order-delivery-fee"
            type="number"
            step="0.01"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            className="w-24 rounded border border-brand-gray/30 px-2 py-1 text-sm"
          />
          <button
            type="button"
            disabled={saving || !changed}
            onClick={() => save(Number.isFinite(typed) && typed !== 0 ? typed : null)}
            className="rounded bg-brand-blue px-2 py-1 text-xs text-white disabled:opacity-50"
          >
            Save
          </button>
          {quote.amount != null && quote.amount !== current?.amount && (
            <button
              type="button"
              disabled={saving}
              onClick={() => save(quote.amount)}
              className="text-xs text-brand-blue underline disabled:opacity-50"
            >
              Charge the zone&apos;s {formatCurrency(quote.amount)}
            </button>
          )}
          {current && (
            <button
              type="button"
              disabled={saving}
              onClick={() => save(null)}
              className="text-xs text-red-600 underline disabled:opacity-50"
            >
              Remove
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ZoneNote({
  fee,
  formatCurrency,
}: Readonly<{ fee: OrderDeliveryFee; formatCurrency: (n: number) => string }>) {
  const { quote } = fee;
  if (quote.zone && quote.amount != null) {
    const pieces = `${quote.pieces} piece${quote.pieces === 1 ? "" : "s"}`;
    return (
      <>
        {quote.zone.name}, {pieces}: {formatCurrency(quote.amount)}
      </>
    );
  }
  if (quote.zip) return <>No delivery zone covers ZIP {quote.zip}.</>;
  return <>No delivery address or customer address on file.</>;
}
