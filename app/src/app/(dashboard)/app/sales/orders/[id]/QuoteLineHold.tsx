"use client";

// GAP-16: a quote line's hold, on the order screen. A quote commits only the
// floor stock it holds, so this says whether the line's piece is held for the
// customer and through which day, and lets staff hold it, move the day or take
// the hold off (line-items/[lineItemId] PUT, action "hold"). The days on offer
// are the store's (Settings › Quote holds); the server decides again on save.

import { useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { format } from "date-fns";
import { parseLocalDate } from "@/lib/dateUtils";
import { getErrorMessage } from "@/lib/toastError";
import { holdIsOpen, type QuoteHoldPolicy } from "@/lib/sales/quoteHoldsShared";

interface Props {
  orderId: number;
  line: { id: number; name: string; holdUntil: string | null };
  policy: QuoteHoldPolicy | null;
  onChanged: () => void;
}

function holdStatus(holdUntil: string | null, open: boolean): string {
  if (!holdUntil) return "Not held";
  const day = format(parseLocalDate(holdUntil), "MMM d");
  return open ? `Held through ${day}` : `Hold ended ${day}`;
}

export function QuoteLineHold({ orderId, line, policy, onChanged }: Readonly<Props>) {
  const [day, setDay] = useState(line.holdUntil ?? "");
  const [saving, setSaving] = useState(false);
  const open = policy != null && holdIsOpen(line.holdUntil, policy.today);

  const save = async (holdUntil: string | null) => {
    setSaving(true);
    try {
      await axios.put(
        `/api/sales/orders/${encodeURIComponent(String(orderId))}/line-items/${line.id}`,
        { action: "hold", holdUntil },
      );
      toast.success(holdUntil ? "Held for the customer." : "Hold taken off.");
      onChanged();
    } catch (err) {
      toast.error(getErrorMessage(err, "Couldn't change the hold."));
    } finally {
      setSaving(false);
    }
  };

  const status = holdStatus(line.holdUntil, open);

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1 text-xs">
      <span className={open ? "text-green-700" : "text-brand-gray"}>{status}</span>
      {policy?.latest && (
        <>
          <input
            type="date"
            min={policy.today}
            max={policy.latest}
            value={day}
            onChange={(e) => setDay(e.target.value)}
            aria-label={`Hold ${line.name} until`}
            className="rounded border border-brand-gray/30 bg-white px-1 py-0.5 text-xs"
          />
          <button
            type="button"
            disabled={saving || !day || day === line.holdUntil}
            onClick={() => save(day)}
            className="rounded border border-brand-blue px-1.5 py-0.5 text-brand-blue disabled:opacity-40"
          >
            {line.holdUntil ? "Change" : "Hold"}
          </button>
        </>
      )}
      {line.holdUntil && (
        <button
          type="button"
          disabled={saving}
          onClick={() => save(null)}
          className="px-1 text-brand-gray hover:text-red-600 disabled:opacity-40"
        >
          Take off
        </button>
      )}
    </div>
  );
}
