"use client";

// /app/src/app/(dashboard)/app/purchasing/low-stock/LowStockView.tsx
//
// What's below its reorder point, store by store (lib/purchasing/lowStock.ts).
// Ticked lines go on each vendor's open draft PO for the store, or a new one,
// through /api/scan/order: the same filing a reorder scanned on the floor gets.
// Each store is one request, since a PO has one ship-to, with its own action key
// so a resend adds nothing twice.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import axios from "axios";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";
import type { LowStockRow } from "@/lib/purchasing/lowStockShared";
import type { FiledPo } from "@/lib/purchasing/purchaseOrderShared";

function orderableRows(rows: LowStockRow[]): LowStockRow[] {
  return rows.filter((r) => r.suggested > 0 && r.vendorId != null);
}

export function LowStockView({ canOrder }: Readonly<{ canOrder: boolean }>) {
  const [rows, setRows] = useState<LowStockRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [storeId, setStoreId] = useState("");
  const [ticked, setTicked] = useState<Set<number>>(new Set());
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState(false);
  const [filed, setFiled] = useState<FiledPo[]>([]);

  const load = useCallback(
    () =>
      axios
        .get<{ rows: LowStockRow[] }>("/api/purchasing/low-stock")
        .then((res) => setRows(res.data.rows))
        .catch((err: unknown) => toast.error(getErrorMessage(err, "Couldn't load low stock.")))
        .finally(() => setLoading(false)),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const stores = useMemo(() => {
    const byId = new Map(rows.map((r) => [r.storeLocationId, r.store]));
    return [...byId].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);
  const shown = storeId ? rows.filter((r) => String(r.storeLocationId) === storeId) : rows;

  const toggle = (id: number) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const order = async () => {
    const chosen = orderableRows(shown).filter((r) => ticked.has(r.reorderPointId));
    const byStore = new Map<number, LowStockRow[]>();
    for (const r of chosen) {
      byStore.set(r.storeLocationId, [...(byStore.get(r.storeLocationId) ?? []), r]);
    }
    setSaving(true);
    try {
      const done: FiledPo[] = [];
      for (const [shipToLocationId, lines] of byStore) {
        const res = await axios.post<{ pos: FiledPo[] }>("/api/scan/order", {
          actionKey: crypto.randomUUID(),
          shipToLocationId,
          lines: lines.map((r) => ({
            productId: r.productId,
            vendorId: r.vendorId,
            quantity: quantities[r.reorderPointId] ?? r.suggested,
          })),
        });
        done.push(...res.data.pos);
      }
      setFiled(done);
      setTicked(new Set());
      setQuantities({});
      toast.success(`On ${done.length} draft PO${done.length === 1 ? "" : "s"}.`);
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err, "Couldn't add them to a draft PO."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="py-2 font-serif">
      <p className="mb-4 max-w-2xl text-brand-gray">
        What&apos;s below the level you keep at each store, counting free stock and POs already
        sent. Set a level on a product, under Keep in stock. A draft PO doesn&apos;t count, since
        nothing has been ordered yet, but its quantity isn&apos;t suggested again.
      </p>
      {stores.length > 1 && (
        <div className="mb-4">
          <label htmlFor="low-stock-store" className="mr-2 text-sm text-brand-gray">
            Store
          </label>
          <select
            id="low-stock-store"
            value={storeId}
            onChange={(e) => setStoreId(e.target.value)}
            className="rounded-md border border-brand-accent-gray px-3 py-2"
          >
            <option value="">All</option>
            {stores.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </div>
      )}
      {loading && <p className="text-brand-gray">Loading...</p>}
      {!loading && shown.length === 0 && (
        <p className="text-brand-gray">Nothing is below its level.</p>
      )}
      {filed.length > 0 && (
        <ul className="mb-4 space-y-1 text-sm">
          {filed.map((po) => (
            <li key={po.id}>
              <Link href={`/app/purchasing/orders/${po.id}`} className="text-brand-blue underline">
                {po.poNumber}
              </Link>{" "}
              {po.vendor}: {po.lines} line{po.lines === 1 ? "" : "s"}
              {po.created ? " on a new draft" : " added to its draft"}
            </li>
          ))}
        </ul>
      )}
      {shown.length > 0 && (
        <>
          <div className="overflow-x-auto rounded-md border border-black/10 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="bg-brand-linen text-brand-black">
                <tr>
                  {canOrder && <th className="p-2" aria-label="Order" />}
                  <th className="p-2">Store</th>
                  <th className="p-2">Item</th>
                  <th className="p-2">Vendor</th>
                  <th className="p-2 text-right">Free</th>
                  <th className="p-2 text-right">On order</th>
                  <th className="p-2 text-right">Keep</th>
                  <th className="p-2 text-right">Short by</th>
                  <th className="p-2 text-right">On a draft</th>
                  <th className="p-2 text-right">Order</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const orderable = r.suggested > 0 && r.vendorId != null;
                  return (
                    <tr key={r.reorderPointId} className="border-t border-black/5">
                      {canOrder && (
                        <td className="p-2">
                          <input
                            type="checkbox"
                            disabled={!orderable}
                            checked={ticked.has(r.reorderPointId)}
                            onChange={() => toggle(r.reorderPointId)}
                            aria-label={`Order ${r.productName} for ${r.store}`}
                          />
                        </td>
                      )}
                      <td className="p-2 whitespace-nowrap">{r.store}</td>
                      <td className="p-2">
                        <Link
                          href={`/app/inventory/products/${r.productId}`}
                          className="text-brand-blue underline"
                        >
                          {r.productName}
                        </Link>
                        <span className="block text-xs text-brand-gray">{r.productNumber}</span>
                      </td>
                      <td className="p-2">{r.vendor ?? "No vendor"}</td>
                      <td className="p-2 text-right">{r.free}</td>
                      <td className="p-2 text-right">{r.onOrder}</td>
                      <td className="p-2 text-right">{r.minQuantity}</td>
                      <td className="p-2 text-right">{r.shortBy}</td>
                      <td className="p-2 text-right">{r.onDraft}</td>
                      <td className="p-2 text-right">
                        {canOrder && orderable ? (
                          <input
                            type="number"
                            min={0}
                            step="any"
                            value={quantities[r.reorderPointId] ?? r.suggested}
                            onChange={(e) =>
                              setQuantities((q) => ({ ...q, [r.reorderPointId]: e.target.value }))
                            }
                            aria-label={`How many ${r.productName} to order`}
                            className="w-20 rounded border border-brand-gray/30 px-2 py-1 text-right"
                          />
                        ) : (
                          r.suggested
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {canOrder && (
            <div className="mt-3">
              <Button onClick={order} disabled={saving || ticked.size === 0}>
                {saving ? "Adding..." : `Add ${ticked.size} to draft POs`}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
