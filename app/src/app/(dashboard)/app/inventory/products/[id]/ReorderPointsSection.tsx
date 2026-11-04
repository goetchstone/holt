"use client";

// GAP-14: how many of this product to keep at each store, on the product page
// (/api/products/[id]/reorder-points). Below that level it's on Purchasing > Low
// Stock. Only whoever buys can change it, and a store with no level shows none.

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";

interface Point {
  storeLocationId: number;
  minQuantity: number;
  orderQuantity: number | null;
}

interface Store {
  id: number;
  name: string;
}

const INPUT = "w-24 rounded border border-brand-gray/30 px-2 py-1 text-sm";

export function ReorderPointsSection({
  productId,
  canEdit,
}: Readonly<{ productId: number; canEdit: boolean }>) {
  const [points, setPoints] = useState<Point[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const url = `/api/products/${encodeURIComponent(String(productId))}/reorder-points`;

  const load = useCallback(
    () =>
      axios
        .get<{ points: Point[]; stores: Store[] }>(url)
        .then((res) => {
          setPoints(res.data.points);
          setStores(res.data.stores);
        })
        .catch((err: unknown) =>
          toast.error(getErrorMessage(err, "Couldn't load the reorder points.")),
        ),
    [url],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const shown = canEdit
    ? stores
    : stores.filter((s) => points.some((p) => p.storeLocationId === s.id));
  if (shown.length === 0) return null;
  return (
    <div className="bg-white p-6 rounded-lg shadow-md mb-6">
      <h2 className="text-xl font-semibold mb-1">Keep in stock</h2>
      <p className="mb-3 text-xs text-brand-gray">
        How many to keep at each store. Below that, counting what&apos;s on POs already sent,
        it&apos;s on Purchasing → Low Stock. Leave a store blank to keep no set number there.
      </p>
      <ul className="space-y-2">
        {shown.map((store) => (
          <StoreRow
            key={`${store.id}-${points.find((p) => p.storeLocationId === store.id)?.minQuantity ?? ""}`}
            store={store}
            point={points.find((p) => p.storeLocationId === store.id) ?? null}
            url={url}
            canEdit={canEdit}
            onSaved={load}
          />
        ))}
      </ul>
    </div>
  );
}

function StoreRow({
  store,
  point,
  url,
  canEdit,
  onSaved,
}: Readonly<{
  store: Store;
  point: Point | null;
  url: string;
  canEdit: boolean;
  onSaved: () => Promise<unknown>;
}>) {
  const [min, setMin] = useState(point ? String(point.minQuantity) : "");
  const [least, setLeast] = useState(
    point?.orderQuantity == null ? "" : String(point.orderQuantity),
  );
  const [saving, setSaving] = useState(false);
  const changed =
    min !== (point ? String(point.minQuantity) : "") ||
    least !== (point?.orderQuantity == null ? "" : String(point.orderQuantity));

  const save = async () => {
    setSaving(true);
    try {
      if (min.trim() === "") {
        await axios.delete(url, { params: { storeLocationId: store.id } });
      } else {
        await axios.put(url, { storeLocationId: store.id, minQuantity: min, orderQuantity: least });
      }
      toast.success(`${store.name}: saved.`);
      await onSaved();
    } catch (err) {
      toast.error(getErrorMessage(err, "Couldn't save the reorder point."));
    } finally {
      setSaving(false);
    }
  };

  if (!canEdit) {
    return (
      <li className="text-sm">
        {store.name}: keep {point?.minQuantity}
        {point?.orderQuantity == null ? "" : `, ordering at least ${point.orderQuantity}`}
      </li>
    );
  }
  return (
    <li className="flex flex-wrap items-center gap-2 text-sm">
      <span className="w-48 font-medium">{store.name}</span>
      <label className="flex items-center gap-1 text-brand-gray">
        Keep
        <input
          type="number"
          min={0}
          step="any"
          value={min}
          onChange={(e) => setMin(e.target.value)}
          aria-label={`How many to keep at ${store.name}`}
          className={INPUT}
        />
      </label>
      <label className="flex items-center gap-1 text-brand-gray">
        Order at least
        <input
          type="number"
          min={0}
          step="any"
          value={least}
          onChange={(e) => setLeast(e.target.value)}
          aria-label={`The least to order at a time for ${store.name}`}
          className={INPUT}
        />
      </label>
      {changed && (
        <Button size="sm" onClick={save} disabled={saving}>
          {saving ? "Saving..." : "Save"}
        </Button>
      )}
    </li>
  );
}
