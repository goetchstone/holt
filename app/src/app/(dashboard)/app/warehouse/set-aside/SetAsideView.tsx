"use client";

// /app/src/app/(dashboard)/app/warehouse/set-aside/SetAsideView.tsx
//
// Set aside body: everything in a quarantine place, oldest first, with what was
// wrong. Back to stock puts it on a sellable place at its store; Write off
// takes it out of the books (POST /api/inventory/set-aside/[positionId]). An
// incomplete set is finished by its missing boxes, so it is listed but not
// acted on here; a store's returns place has its own queue (Returned stock).

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { format } from "date-fns";
import { getErrorMessage } from "@/lib/toastError";
import { LOCATION_TYPE_INFO, isStockLocationType } from "@/lib/inventory/locationTypes";
import type { SetAsideRow } from "@/lib/inventory/setAside";

type Row = Omit<SetAsideRow, "since"> & { since: string };

interface Place {
  id: number;
  name: string;
  locationType: string;
  isActive: boolean;
}

export function SetAsideView() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [places, setPlaces] = useState<Map<number, Place[]>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    axios
      .get<{ items: Row[] }>("/api/inventory/set-aside")
      .then((res) => setRows(res.data.items))
      .catch((err) => setError(getErrorMessage(err, "Couldn't load set-aside stock.")));
  }, []);

  useEffect(() => {
    load();
    axios
      .get<{ locations: { id: number; stockLocations: Place[] }[] }>(
        "/api/store-locations/stock-locations",
      )
      .then((res) => {
        const sellable = new Map<number, Place[]>();
        for (const store of res.data.locations) {
          sellable.set(
            store.id,
            store.stockLocations.filter(
              (p) =>
                p.isActive &&
                isStockLocationType(p.locationType) &&
                LOCATION_TYPE_INFO[p.locationType].sellable,
            ),
          );
        }
        setPlaces(sellable);
      })
      .catch(() => setPlaces(new Map()));
  }, [load]);

  return (
    <div className="py-2 space-y-4 font-serif">
      <h1 className="text-2xl text-brand-blue font-semibold">Set aside</h1>
      <p className="text-sm text-brand-gray">
        Stock in quarantine: damaged, a wrong item, an incomplete set. It is counted and valued but
        not for sale. Put it back on sale once it is fixed, or write it off. Mark stock damaged from
        Warehouse › Inventory by Location.
      </p>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {rows?.length === 0 && <p className="text-sm text-brand-gray">Nothing is set aside.</p>}
      {rows && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-brand-linen text-brand-black">
              <tr>
                <th className="p-2 border-b">Product</th>
                <th className="p-2 border-b">Where</th>
                <th className="p-2 border-b text-right">Qty</th>
                <th className="p-2 border-b">What is wrong</th>
                <th className="p-2 border-b whitespace-nowrap">Since</th>
                <th className="p-2 border-b">Do</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <SetAsideRowView
                  key={r.positionId}
                  row={r}
                  places={places.get(r.storeLocationId) ?? []}
                  onDone={load}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SetAsideRowView({
  row,
  places,
  onDone,
}: Readonly<{ row: Row; places: Place[]; onDone: () => void }>) {
  const [quantity, setQuantity] = useState(String(row.quantity));
  const [placeId, setPlaceId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const act = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    try {
      await axios.post(`/api/inventory/set-aside/${row.positionId}`, {
        ...body,
        quantity: Number(quantity),
      });
      toast.success(done);
      onDone();
    } catch (err) {
      toast.error(getErrorMessage(err, "Couldn't do that."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr className="odd:bg-white even:bg-brand-stripe align-top">
      <td className="p-2 border-b">
        {row.productNumber}
        <span className="block text-xs text-brand-gray">{row.productName}</span>
        {row.orderno && <span className="block text-xs text-brand-gray">For {row.orderno}</span>}
      </td>
      <td className="p-2 border-b text-xs">
        {row.storeName}
        <span className="block text-brand-gray">{row.placeName}</span>
      </td>
      <td className="p-2 border-b text-right">{row.quantity}</td>
      <td className="p-2 border-b text-xs">{row.note ?? "—"}</td>
      <td className="p-2 border-b text-xs whitespace-nowrap">
        {format(new Date(row.since), "MMM d")}
      </td>
      <td className="p-2 border-b text-xs">
        {row.incompleteSet ? (
          <span className="text-brand-gray">
            Incomplete set: receive its missing boxes on the handheld, or count it absent.
          </span>
        ) : (
          <div className="flex flex-col gap-1">
            <label className="flex items-center gap-1">
              Qty
              <input
                type="number"
                min={0}
                max={row.quantity}
                step="any"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                aria-label={`How many of ${row.productName}`}
                className="w-16 rounded border border-brand-gray/30 px-1 py-0.5"
              />
            </label>
            <div className="flex items-center gap-1">
              <select
                value={placeId}
                onChange={(e) => setPlaceId(e.target.value)}
                aria-label={`Where ${row.productName} goes back to`}
                className="rounded border border-brand-gray/30 px-1 py-0.5"
              >
                <option value="">Back to…</option>
                {places.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={busy || !placeId}
                onClick={() =>
                  act({ action: "put-back", stockLocationId: Number(placeId) }, "Back on sale.")
                }
                className="rounded border border-brand-blue px-1.5 py-0.5 text-brand-blue disabled:opacity-40"
              >
                Back to stock
              </button>
            </div>
            <div className="flex items-center gap-1">
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Why it is written off"
                aria-label={`Why ${row.productName} is written off`}
                className="w-40 rounded border border-brand-gray/30 px-1 py-0.5"
              />
              <button
                type="button"
                disabled={busy || !note.trim()}
                onClick={() => act({ action: "write-off", note }, "Written off.")}
                className="rounded border border-red-600 px-1.5 py-0.5 text-red-600 disabled:opacity-40"
              >
                Write off
              </button>
            </div>
          </div>
        )}
      </td>
    </tr>
  );
}
