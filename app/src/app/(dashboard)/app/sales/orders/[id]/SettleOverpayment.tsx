// /app/src/app/(dashboard)/app/sales/orders/[id]/SettleOverpayment.tsx
//
// A line change left the customer overpaid: where does the rest go? Asked when the line
// route answers 409 with `overpaid` (DECISIONS 52), inside the dialog that made the change.
"use client";

import type { Overpayment } from "@/lib/sales/cancelOrder";
import type { RefundDestination } from "@/lib/returns/refundReturn";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function SettleOverpayment({
  overpaid,
  refundTo,
  onChange,
}: Readonly<{
  overpaid: Overpayment;
  refundTo: RefundDestination;
  onChange: (next: RefundDestination) => void;
}>) {
  const unfinished = overpaid.refundsToRetry.reduce((sum, r) => sum + r.amount, 0);
  return (
    <div className="mt-3 space-y-2">
      {unfinished > 0 && (
        <p className="text-sm">
          A refund of {money.format(unfinished)} didn&apos;t finish. Saving tries it again.
        </p>
      )}
      {overpaid.toSettle > 0 && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">
            This leaves {money.format(overpaid.toSettle)} more paid than owed. Where does it go?
          </legend>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="line-refund-to"
              className="mt-1"
              checked={refundTo === "ORIGINAL_PAYMENT"}
              onChange={() => onChange("ORIGINAL_PAYMENT")}
            />
            <span>
              Back the way it was paid
              <span className="block text-brand-gray">
                {overpaid.payments.map((p) => `${p.label} ${money.format(p.amount)}`).join(", ")}
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="line-refund-to"
              className="mt-1"
              disabled={overpaid.customerId === null}
              checked={refundTo === "STORE_CREDIT"}
              onChange={() => onChange("STORE_CREDIT")}
            />
            <span>Leave it as credit on the customer&apos;s account</span>
          </label>
        </fieldset>
      )}
    </div>
  );
}
