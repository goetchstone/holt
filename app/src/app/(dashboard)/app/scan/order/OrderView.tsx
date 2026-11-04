"use client";

// /app/src/app/(dashboard)/app/scan/order/OrderView.tsx
//
// Walk the floor and scan what to reorder (GAP-19). Each scan adds one; the
// number on a line can be typed, for a roll ordered by the yard. An item
// bought from more than one vendor names its own first and can be switched to
// another. Saving files each vendor's lines on its newest open draft PO for
// this store, or a new draft (lib/purchasing/scannedOrder.ts); the buyer
// reviews and sends them at the desk. One save, sent with an action key so a
// resend never adds twice.

import { useRef, useState } from "react";
import Link from "next/link";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { ScanFrame, type ScanMessage } from "@/components/scan/ScanFrame";
import { getErrorMessage } from "@/lib/toastError";
import type { FiledPo, OrderableItem } from "@/lib/purchasing/purchaseOrderShared";

interface Line extends OrderableItem {
  vendorId: number;
  /** As typed: checked when saved. */
  quantity: string;
}

const newKey = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function filedText(pos: FiledPo[]): string {
  return pos
    .map(
      (po) =>
        `${po.created ? "New draft" : "Added to"} ${po.poNumber} for ${po.vendor} (${plural(po.lines, "line", "lines")})`,
    )
    .join("; ");
}

export function OrderView() {
  const [lines, setLines] = useState<Line[]>([]);
  const [storeId, setStoreId] = useState<number | null>(null);
  const [message, setMessage] = useState<ScanMessage | null>(null);
  const [filed, setFiled] = useState<FiledPo[]>([]);
  const [busy, setBusy] = useState(false);
  const keyRef = useRef<string | null>(null);

  const change = (next: Line[]) => {
    keyRef.current = null; // what is being sent changed: a new action
    setLines(next);
  };

  const onScan = async (code: string, storeLocationId: number | null) => {
    try {
      const res = await axios.get<OrderableItem>("/api/scan/order", {
        params: { code, storeLocationId: storeLocationId ?? undefined },
      });
      const item = res.data;
      setFiled([]);
      const at = lines.findIndex((l) => l.product.id === item.product.id);
      if (at < 0) {
        change([...lines, { ...item, vendorId: item.vendors[0].id, quantity: "1" }]);
        return setMessage({ tone: "ok", text: `${item.product.name}: 1` });
      }
      const n = (Number(lines[at].quantity) || 0) + 1;
      change(lines.map((l, i) => (i === at ? { ...l, quantity: String(n) } : l)));
      setMessage({ tone: "ok", text: `${item.product.name}: ${n}` });
    } catch (err) {
      setMessage({ tone: "error", text: getErrorMessage(err, "Could not read that scan.") });
    }
  };

  const update = (productId: number, patch: Partial<Line>) =>
    change(lines.map((l) => (l.product.id === productId ? { ...l, ...patch } : l)));

  const save = async () => {
    if (storeId == null) return setMessage({ tone: "error", text: "Choose the store first." });
    keyRef.current ??= newKey();
    setBusy(true);
    try {
      const res = await axios.post<{ pos: FiledPo[] }>("/api/scan/order", {
        actionKey: keyRef.current,
        shipToLocationId: storeId,
        lines: lines.map((l) => ({
          productId: l.product.id,
          vendorId: l.vendorId,
          quantity: l.quantity,
        })),
      });
      setLines([]);
      keyRef.current = null;
      setFiled(res.data.pos);
      setMessage({ tone: "ok", text: filedText(res.data.pos) });
    } catch (err) {
      // The key is kept: sending again is the same action, never a second order.
      setMessage({ tone: "error", text: getErrorMessage(err, "Not saved: send it again.") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScanFrame
      title="Order stock"
      prompt="Scan what to reorder"
      onScan={onScan}
      message={message}
      onStoreChange={setStoreId}
    >
      {filed.length > 0 && (
        <ul className="space-y-1 text-sm">
          {filed.map((po) => (
            <li key={po.id}>
              <Link href={`/app/purchasing/orders/${po.id}`} className="text-brand-blue underline">
                {po.poNumber}
              </Link>{" "}
              {po.vendor}: review and send it at the desk
            </li>
          ))}
        </ul>
      )}
      {lines.length > 0 && (
        <div className="space-y-2">
          <ul className="space-y-2">
            {lines.map((l) => (
              <li key={l.product.id} className="border-b border-brand-gray/10 pb-2 text-sm">
                <div className="flex items-start justify-between gap-2">
                  <span>
                    {l.product.name}
                    <span className="block text-xs text-brand-gray">{l.product.productNumber}</span>
                  </span>
                  <button
                    className="text-xs text-brand-gray underline"
                    onClick={() => change(lines.filter((x) => x.product.id !== l.product.id))}
                    disabled={busy}
                  >
                    Remove
                  </button>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  {l.vendors.length > 1 ? (
                    <select
                      aria-label={`Vendor for ${l.product.name}`}
                      value={l.vendorId}
                      onChange={(e) => update(l.product.id, { vendorId: Number(e.target.value) })}
                      className="min-w-0 flex-1 border border-brand-gray/30 rounded px-2 py-1"
                    >
                      {l.vendors.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name} · {v.partNo}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="min-w-0 flex-1 text-brand-gray">{l.vendors[0].name}</span>
                  )}
                  <input
                    aria-label={`How many ${l.product.name}`}
                    inputMode="decimal"
                    value={l.quantity}
                    onChange={(e) => update(l.product.id, { quantity: e.target.value })}
                    className="w-20 shrink-0 border border-brand-gray/30 rounded px-2 py-1 text-right text-lg"
                  />
                </div>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button onClick={save} disabled={busy} fullWidth className="h-12 text-lg">
              {busy ? "Saving..." : "Save to draft POs"}
            </Button>
            <Button variant="outline" onClick={() => change([])} disabled={busy}>
              Clear
            </Button>
          </div>
        </div>
      )}
    </ScanFrame>
  );
}
