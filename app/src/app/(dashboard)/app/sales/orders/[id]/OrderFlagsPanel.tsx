"use client";

// GAP-07: the store's flags on an order, on the order screen. Each shows as a
// chip; staff add one from the store's list (Settings > Order flags) or take
// one off, through orders/[id]/flags PUT (lib/sales/orderFlags.ts). A flag
// switched off in Settings stays on the orders that carry it and is offered to
// no new one.

import { useEffect, useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { X } from "lucide-react";
import { getErrorMessage } from "@/lib/toastError";
import { type OrderFlagRef, orderFlagChipClasses } from "@/lib/sales/orderFlagsShared";

interface Props {
  orderId: number;
  flags: OrderFlagRef[];
  onChanged: (flags: OrderFlagRef[]) => void;
}

export function OrderFlagChip({ flag }: Readonly<{ flag: OrderFlagRef }>) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${orderFlagChipClasses(flag.color)}`}
    >
      {flag.name}
    </span>
  );
}

export function OrderFlagsPanel({ orderId, flags, onChanged }: Readonly<Props>) {
  const [offered, setOffered] = useState<OrderFlagRef[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    axios
      .get<OrderFlagRef[]>("/api/order-flags")
      .then((res) => setOffered(res.data))
      .catch(() => setOffered([]));
  }, []);

  const save = async (flagIds: number[], done: string) => {
    setSaving(true);
    try {
      const res = await axios.put<{ flags: OrderFlagRef[] }>(
        `/api/sales/orders/${encodeURIComponent(String(orderId))}/flags`,
        { flagIds },
      );
      onChanged(res.data.flags);
      toast.success(done);
    } catch (err) {
      toast.error(getErrorMessage(err, "Couldn't change the flags."));
    } finally {
      setSaving(false);
    }
  };

  const current = flags.map((f) => f.id);
  const addable = offered.filter((f) => !current.includes(f.id));

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {flags.map((flag) => (
        <span key={flag.id} className="inline-flex items-center gap-0.5">
          <OrderFlagChip flag={flag} />
          <button
            type="button"
            disabled={saving}
            onClick={() =>
              save(
                current.filter((id) => id !== flag.id),
                `${flag.name} taken off.`,
              )
            }
            className="p-0.5 text-brand-gray hover:text-red-600 disabled:opacity-40"
            title={`Take ${flag.name} off`}
            aria-label={`Take ${flag.name} off`}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      {addable.length > 0 && (
        <select
          aria-label="Add a flag"
          value=""
          disabled={saving}
          onChange={(e) => {
            const flag = addable.find((f) => f.id === Number(e.target.value));
            if (flag) void save([...current, flag.id], `Flagged ${flag.name}.`);
          }}
          className="rounded border border-brand-gray/30 bg-white px-1.5 py-0.5 text-xs text-brand-gray"
        >
          <option value="">+ Flag</option>
          {addable.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
