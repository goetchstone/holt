"use client";

// GAP-07: the disclaimers an order prints, on the order screen. Staff add one
// from the store's list (Settings > Disclaimers), which copies its text onto
// the order, or take one off -- only while the order is a quote or an order
// (lib/sales/orderDisclaimersShared.ts). Each prints on the invoice and the
// receipt, above the store-wide footer.

import { useEffect, useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { X } from "lucide-react";
import { getErrorMessage } from "@/lib/toastError";
import { type OrderDisclaimerRef, disclaimerEditProblem } from "@/lib/sales/orderDisclaimersShared";

interface Offered {
  id: number;
  name: string;
  text: string;
}

interface Props {
  orderId: number;
  status: string;
  disclaimers: OrderDisclaimerRef[];
  onChanged: (disclaimers: OrderDisclaimerRef[]) => void;
}

export function OrderDisclaimersPanel({
  orderId,
  status,
  disclaimers,
  onChanged,
}: Readonly<Props>) {
  const [offered, setOffered] = useState<Offered[]>([]);
  const [saving, setSaving] = useState(false);
  const locked = disclaimerEditProblem(status);
  const base = `/api/sales/orders/${encodeURIComponent(String(orderId))}/disclaimers`;

  useEffect(() => {
    if (locked) return;
    axios
      .get<Offered[]>("/api/order-disclaimers")
      .then((res) => setOffered(res.data))
      .catch(() => setOffered([]));
  }, [locked]);

  const send = async (
    request: Promise<{ data: { disclaimers: OrderDisclaimerRef[] } }>,
    done: string,
  ) => {
    setSaving(true);
    try {
      const res = await request;
      onChanged(res.data.disclaimers);
      toast.success(done);
    } catch (err) {
      toast.error(getErrorMessage(err, "Couldn't change the disclaimers."));
    } finally {
      setSaving(false);
    }
  };

  const used = new Set(disclaimers.map((d) => d.orderDisclaimerId));
  const addable = offered.filter((d) => !used.has(d.id));
  if (disclaimers.length === 0 && (locked || addable.length === 0)) return null;

  return (
    <div className="bg-white p-6 rounded-lg shadow-md mb-6">
      <h2 className="text-xl font-semibold mb-1">Disclaimers</h2>
      <p className="mb-3 text-xs text-brand-gray">
        Printed on the invoice and receipt, above your store-wide footer.
        {locked && ` ${locked}`}
      </p>
      {disclaimers.length > 0 && (
        <ul className="mb-3 space-y-2">
          {disclaimers.map((d) => (
            <li key={d.id} className="flex items-start gap-2 text-sm">
              <p className="flex-1 whitespace-pre-line">{d.text}</p>
              {!locked && (
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => send(axios.delete(`${base}/${d.id}`), "Disclaimer taken off.")}
                  className="p-1 text-brand-gray hover:text-red-600 disabled:opacity-40"
                  title="Take this disclaimer off"
                  aria-label="Take this disclaimer off"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!locked && addable.length > 0 && (
        <select
          aria-label="Add a disclaimer"
          value=""
          disabled={saving}
          onChange={(e) => {
            const d = addable.find((o) => o.id === Number(e.target.value));
            if (d) void send(axios.post(base, { orderDisclaimerId: d.id }), `${d.name} added.`);
          }}
          className="rounded border border-brand-gray/30 bg-white px-2 py-1 text-sm"
        >
          <option value="">+ Add a disclaimer</option>
          {addable.map((d) => (
            <option key={d.id} value={d.id} title={d.text}>
              {d.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
