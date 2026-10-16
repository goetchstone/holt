"use client";

// /app/src/app/(dashboard)/app/sales/orders/[id]/ApplyStoreCredit.tsx
//
// Spend the order's customer's store credit on what the order still owes: a
// rewrite, an exchange, or any order taken off the register. The register
// offers the same as a tender. Posts a STORE_CREDIT payment; the server spends
// the credit on the customer's own order only (lib/customerCredit.ts) and
// refuses anyone without payment.take, with a message this shows (rule 11).

import { useEffect, useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";

export function ApplyStoreCredit({
  orderId,
  customerId,
  balanceDue,
  formatCurrency,
  onApplied,
}: {
  orderId: number;
  customerId: number;
  balanceDue: number;
  formatCurrency: (n: number) => string;
  onApplied: () => void;
}) {
  const [credit, setCredit] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    axios
      .get<{ balance: number }>(`/api/customers/${customerId}/credit`)
      .then((res) => live && setCredit(Number(res.data.balance) || 0))
      .catch(() => live && setCredit(null));
    return () => {
      live = false;
    };
  }, [customerId, balanceDue]);

  if (!credit || credit <= 0 || balanceDue <= 0) return null;
  const amount = Math.round(Math.min(credit, balanceDue) * 100) / 100;

  const apply = async () => {
    setBusy(true);
    try {
      await axios.post(`/api/sales/orders/${orderId}/payments`, {
        method: "STORE_CREDIT",
        amount,
        customerId,
      });
      toast.success(`${formatCurrency(amount)} of store credit applied.`);
      onApplied();
    } catch (err) {
      toast.error(getErrorMessage(err, "The store credit was not applied."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 flex items-center gap-3 text-sm">
      <span className="text-brand-gray">Store credit: {formatCurrency(credit)}</span>
      <Button size="sm" variant="outline" onClick={apply} disabled={busy}>
        {busy ? "Applying..." : `Apply ${formatCurrency(amount)}`}
      </Button>
    </div>
  );
}
