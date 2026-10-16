"use client";

// /app/src/app/(dashboard)/app/sales/returns/[id]/RefundPanel.tsx
//
// Paying out a return (lib/returns/refundReturn.ts): what came back is worth,
// the restocking fee (typed per return, 0 unless staff say otherwise, fixed
// once the first refund books it), every refund so far, and a refund to a
// payment on the original order or to the customer's store credit. The
// server checks every rule again; this panel only offers what it would allow
// and shows its message when it refuses (rule 11).

import { useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { getErrorMessage } from "@/lib/toastError";
import type { ReturnDetail } from "@/lib/returns/returnDetailContract";

type FeeMode = "percent" | "amount";
type Money = ReturnDetail["money"];

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The fee as the server would book it: fixed once booked, else typed here, within the goods' net. */
function feeOf(money: Money, mode: FeeMode, value: number): number {
  if (money.feeBooked) return money.restockingFee;
  const raw = mode === "percent" ? (money.returnedNet * value) / 100 : value;
  return round2(Math.min(Math.max(raw, 0), Math.max(money.returnedNet, 0)));
}

/** What the next refund can pay: first what the original owes, then the customer. */
function previewOf(money: Money, fee: number) {
  const goods = round2(money.returnedNet + money.returnedTax);
  // Before booking the fee is still the screen's; after, the server's figure is final.
  const available = money.feeBooked
    ? money.refundable + money.originalOwes
    : Math.max(0, round2(goods - fee - money.refundedTotal));
  const owes = Math.min(money.originalOwes, available);
  return { goods, owes, refundableNow: Math.max(0, round2(available - owes)) };
}

/** The fee to send: only on the first refund, and only when there is one. */
function feePayload(money: Money, mode: FeeMode, value: number) {
  if (money.feeBooked || value === 0) return undefined;
  return mode === "percent" ? { percent: value } : { amount: value };
}

export function RefundPanel({
  returnId,
  detail,
  onChanged,
}: {
  returnId: number;
  detail: ReturnDetail;
  onChanged: () => void;
}) {
  const money = detail.money;
  const [feeMode, setFeeMode] = useState<FeeMode>("percent");
  const [feeInput, setFeeInput] = useState("");
  const [destination, setDestination] = useState<Destination>(
    money.payments.length > 0 ? "ORIGINAL_PAYMENT" : "STORE_CREDIT",
  );
  const [paymentId, setPaymentId] = useState<number | "">(money.payments[0]?.id ?? "");
  const [amountInput, setAmountInput] = useState("");
  const [busy, setBusy] = useState(false);

  const feeValue = Number(feeInput) || 0;
  const fee = feeOf(money, feeMode, feeValue);
  const { goods, owes, refundableNow } = previewOf(money, fee);
  const payment = money.payments.find((p) => p.id === paymentId);
  const toPayment = destination === "ORIGINAL_PAYMENT" && payment != null;
  const cap = toPayment ? Math.min(refundableNow, payment.remaining) : refundableNow;
  // Nothing left to give back: the refund books the return and pays the order.
  const applyOnly = refundableNow <= 0 && owes > 0;
  const typed = amountInput === "" ? cap : Number(amountInput);
  const amount = applyOnly ? 0 : typed;
  const feeBlocked = !money.feeBooked && fee > 0 && !money.feeAccountMapped;
  const actionLabel = applyOnly ? `Apply to ${detail.salesOrder.orderno}` : "Refund";

  const submit = async () => {
    if (!applyOnly && !(amount > 0)) {
      toast.error("Enter an amount to refund.");
      return;
    }
    setBusy(true);
    try {
      await axios.post(`/api/returns/${returnId}/refund`, {
        destination,
        paymentId: toPayment ? paymentId : undefined,
        amount,
        restockingFee: feePayload(money, feeMode, feeValue),
      });
      toast.success(applyOnly ? `Applied to ${detail.salesOrder.orderno}.` : "Refund recorded.");
      setAmountInput("");
      onChanged();
    } catch (err) {
      toast.error(getErrorMessage(err, "The refund was not recorded."));
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const retry = async (refundPaymentId: number) => {
    setBusy(true);
    try {
      await axios.post(`/api/returns/${returnId}/refund`, {
        retryRefundPaymentId: refundPaymentId,
      });
      toast.success("Refund confirmed by the processor.");
    } catch (err) {
      toast.error(getErrorMessage(err, "The processor still has not confirmed the refund."));
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  return (
    <div className="bg-white p-6 rounded-lg shadow-md mb-6">
      <h2 className="text-xl font-semibold mb-3">Refund</h2>
      {!money.valued || money.blockedReason ? (
        <p className="text-sm text-brand-gray">{money.blockedReason}</p>
      ) : (
        <div className="space-y-4 text-sm">
          <RefundSummary
            detail={detail}
            goods={goods}
            fee={fee}
            owes={owes}
            refundableNow={refundableNow}
            feeMode={feeMode}
            onFeeMode={setFeeMode}
            feeInput={feeInput}
            onFeeInput={setFeeInput}
            feeBlocked={feeBlocked}
          />

          <RefundHistory refunds={money.refunds} busy={busy} onRetry={retry} />

          {refundableNow > 0 || owes > 0 ? (
            <div className="space-y-3">
              <DestinationPicker
                detail={detail}
                destination={destination}
                onDestination={setDestination}
                paymentId={paymentId}
                onPayment={setPaymentId}
              />
              <div className="flex items-end gap-3">
                <div>
                  <label htmlFor="refund-amount" className="block font-medium mb-1">
                    Amount
                  </label>
                  <input
                    id="refund-amount"
                    type="number"
                    step="0.01"
                    min="0.01"
                    max={cap}
                    value={amountInput}
                    onChange={(e) => setAmountInput(e.target.value)}
                    placeholder={cap.toFixed(2)}
                    className="w-32 border border-brand-gray/30 rounded px-3 py-2"
                  />
                </div>
                <Button
                  size="sm"
                  onClick={submit}
                  disabled={busy || feeBlocked || (!applyOnly && (amount > cap || amount <= 0))}
                >
                  {busy ? "Processing..." : actionLabel}
                </Button>
              </div>
              {owes > 0 && refundableNow <= 0 && (
                <p className="text-xs text-brand-gray">
                  The whole return goes to what {detail.salesOrder.orderno} still owes; nothing is
                  left to give back.
                </p>
              )}
            </div>
          ) : (
            <p className="text-brand-gray">Nothing is left to refund on this return.</p>
          )}
        </div>
      )}
    </div>
  );
}

type Destination = "ORIGINAL_PAYMENT" | "STORE_CREDIT";

function RefundHistory({
  refunds,
  busy,
  onRetry,
}: {
  refunds: Money["refunds"];
  busy: boolean;
  onRetry: (refundPaymentId: number) => void;
}) {
  const formatCurrency = useMoneyFormatter();
  if (refunds.length === 0) return null;
  return (
    <table className="w-full text-sm">
      <tbody>
        {refunds.map((r) => (
          <tr key={r.id} className="border-b border-brand-gray/10">
            <td className="py-1">{format(new Date(r.date), "PP")}</td>
            <td className="py-1">
              {r.destination === "STORE_CREDIT" ? "Store credit" : r.paymentType}
            </td>
            <td className="py-1 text-right">{formatCurrency(r.amount)}</td>
            <td className="py-1 pl-3 text-xs text-brand-gray">
              {r.status === "PENDING" ? "Waiting on the processor" : (r.status ?? "")}
            </td>
            <td className="py-1 text-right">
              {r.retryable && (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => onRetry(r.id)}>
                  Retry
                </Button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DestinationPicker({
  detail,
  destination,
  onDestination,
  paymentId,
  onPayment,
}: {
  detail: ReturnDetail;
  destination: Destination;
  onDestination: (d: Destination) => void;
  paymentId: number | "";
  onPayment: (id: number | "") => void;
}) {
  const formatCurrency = useMoneyFormatter();
  const payments = detail.money.payments;
  const customer = detail.customer;
  const creditLabel = customer
    ? `Store credit for ${customer.name} (balance ${formatCurrency(customer.creditBalance)})`
    : "Store credit (needs a customer on the order)";
  return (
    <fieldset className="space-y-1.5">
      <legend className="font-medium mb-1">Refund to</legend>
      <label className="flex items-center gap-2">
        <input
          type="radio"
          name="refund-destination"
          checked={destination === "ORIGINAL_PAYMENT"}
          disabled={payments.length === 0}
          onChange={() => onDestination("ORIGINAL_PAYMENT")}
        />
        The original payment
        {payments.length === 0 && (
          <span className="text-xs text-brand-gray">(nothing left to refund on it)</span>
        )}
      </label>
      {destination === "ORIGINAL_PAYMENT" && payments.length > 0 && (
        <select
          aria-label="Payment to refund"
          value={paymentId}
          onChange={(e) => onPayment(e.target.value ? Number(e.target.value) : "")}
          className="ml-6 border border-brand-gray/30 rounded px-2 py-1"
        >
          {payments.map((p) => (
            <option key={p.id} value={p.id}>
              {p.paymentType}
              {p.cardLast4 ? ` ••${p.cardLast4}` : ""} — {formatCurrency(p.remaining)} left
            </option>
          ))}
        </select>
      )}
      <label className="flex items-center gap-2">
        <input
          type="radio"
          name="refund-destination"
          checked={destination === "STORE_CREDIT"}
          disabled={!customer}
          onChange={() => onDestination("STORE_CREDIT")}
        />
        {creditLabel}
      </label>
    </fieldset>
  );
}

function RefundSummary({
  detail,
  goods,
  fee,
  owes,
  refundableNow,
  feeMode,
  onFeeMode,
  feeInput,
  onFeeInput,
  feeBlocked,
}: {
  detail: ReturnDetail;
  goods: number;
  fee: number;
  owes: number;
  refundableNow: number;
  feeMode: FeeMode;
  onFeeMode: (m: FeeMode) => void;
  feeInput: string;
  onFeeInput: (v: string) => void;
  feeBlocked: boolean;
}) {
  const formatCurrency = useMoneyFormatter();
  const money = detail.money;
  const orderno = detail.salesOrder.orderno;
  return (
    <>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
        <span className="text-brand-gray">What came back</span>
        <span className="text-right">
          {formatCurrency(goods)}
          <span className="text-xs text-brand-gray">
            {" "}
            ({formatCurrency(money.returnedNet)} + {formatCurrency(money.returnedTax)} tax)
          </span>
        </span>
        <span className="text-brand-gray">Restocking fee</span>
        <span className="text-right">
          {money.feeBooked ? (
            formatCurrency(money.restockingFee)
          ) : (
            <span className="inline-flex items-center gap-2 justify-end">
              <input
                aria-label="Restocking fee"
                type="number"
                min="0"
                step={feeMode === "percent" ? "1" : "0.01"}
                value={feeInput}
                onChange={(e) => onFeeInput(e.target.value)}
                placeholder="0"
                className="w-20 border border-brand-gray/30 rounded px-2 py-1 text-right"
              />
              <select
                aria-label="Fee as"
                value={feeMode}
                onChange={(e) => onFeeMode(e.target.value as FeeMode)}
                className="border border-brand-gray/30 rounded px-1 py-1"
              >
                <option value="percent">%</option>
                <option value="amount">$</option>
              </select>
              <span>−{formatCurrency(fee)}</span>
            </span>
          )}
        </span>
        {money.refundedTotal > 0 && (
          <>
            <span className="text-brand-gray">Refunded so far</span>
            <span className="text-right">−{formatCurrency(money.refundedTotal)}</span>
          </>
        )}
        {owes > 0 && (
          <>
            <span className="text-brand-gray">Pays what {orderno} still owes</span>
            <span className="text-right">−{formatCurrency(owes)}</span>
          </>
        )}
        <span className="font-medium">Can be refunded now</span>
        <span className="text-right font-medium">{formatCurrency(refundableNow)}</span>
      </div>
      {!money.feeBooked && (
        <p className="text-xs text-brand-gray">
          The fee is fixed by the first refund.
          {feeBlocked &&
            ' To keep a fee, map "Restocking Fee" under POS Transactions in Admin › Setup › Accounting.'}
        </p>
      )}
    </>
  );
}
