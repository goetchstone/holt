"use client";

// /app/src/app/(dashboard)/app/warehouse/returns/ReturnedStockPanel.tsx
//
// A store's returned-stock queue (owner direction 2026-10-16): every returned
// piece sitting in the store's returns place, waiting to be put back on a
// sellable place or written off. The customer's return does not wait on this;
// it may already be closed. Reads /api/warehouse/returns/returned-stock and
// acts through /api/returns/[id]/disposition.

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { format } from "date-fns";

import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";
import { isStockLocationType, LOCATION_TYPE_INFO } from "@/lib/inventory/locationTypes";

interface ReturnedPiece {
  id: number;
  returnNumber: string;
  status: string;
  productName: string | null;
  partNo: string | null;
  quantity: number;
  receivedAt: string | null;
  inspectionCondition: string | null;
  storeLocationId: number | null;
  storeName: string | null;
  placeName: string | null;
  orderno: string;
}

interface StoreWithPlaces {
  id: number;
  name: string;
  isActive: boolean;
  stockLocations: { id: number; name: string; locationType: string; isActive: boolean }[];
}

const CONDITION_LABELS: Record<string, string> = {
  LIKE_NEW: "Like new",
  MINOR_DAMAGE: "Minor damage",
  MAJOR_DAMAGE: "Major damage",
  UNSALVAGEABLE: "Unsalvageable",
};

export function ReturnedStockPanel() {
  const [stores, setStores] = useState<StoreWithPlaces[]>([]);
  const [storeId, setStoreId] = useState<string>("");
  const [items, setItems] = useState<ReturnedPiece[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [placeFor, setPlaceFor] = useState<Record<number, string>>({});
  const [reasonFor, setReasonFor] = useState<Record<number, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await axios.get<{ items: ReturnedPiece[] }>(
        "/api/warehouse/returns/returned-stock",
        { params: storeId ? { storeLocationId: storeId } : {} },
      );
      setItems(res.data.items);
    } catch (err) {
      toast.error(getErrorMessage(err, "Could not load returned stock"));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [storeId]);

  useEffect(() => {
    axios
      .get<{ locations: StoreWithPlaces[] }>("/api/store-locations/stock-locations")
      .then((res) => setStores(res.data.locations.filter((s) => s.isActive)))
      .catch((err) => toast.error(getErrorMessage(err, "Could not load stores")));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const sellablePlaces = (storeLocationId: number | null) =>
    stores
      .find((s) => s.id === storeLocationId)
      ?.stockLocations.filter(
        (p) =>
          p.isActive &&
          isStockLocationType(p.locationType) &&
          LOCATION_TYPE_INFO[p.locationType].sellable,
      ) ?? [];

  const act = async (piece: ReturnedPiece, body: Record<string, unknown>, done: string) => {
    setBusyId(piece.id);
    try {
      await axios.post(`/api/returns/${piece.id}/disposition`, body);
      toast.success(done);
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err, "Could not record what happened to the piece"));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <label htmlFor="returned-stock-store" className="text-sm text-brand-gray">
          Store:
        </label>
        <select
          id="returned-stock-store"
          value={storeId}
          onChange={(e) => setStoreId(e.target.value)}
          className="border border-brand-gray/30 rounded px-2 py-1 text-sm"
        >
          <option value="">All stores</option>
          {stores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      {loading && <p className="text-brand-gray">Loading...</p>}
      {!loading && items.length === 0 && (
        <p className="text-sm text-brand-gray">
          Nothing waiting: every returned piece is dealt with.
        </p>
      )}
      {!loading && items.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-brand-gray border-b border-brand-gray/20">
                <th className="py-2 pr-3">Return</th>
                <th className="py-2 pr-3">Piece</th>
                <th className="py-2 pr-3">Qty</th>
                <th className="py-2 pr-3">Where</th>
                <th className="py-2 pr-3">Condition</th>
                <th className="py-2">Put back or write off</th>
              </tr>
            </thead>
            <tbody>
              {items.map((piece) => {
                const places = sellablePlaces(piece.storeLocationId);
                return (
                  <tr key={piece.id} className="border-b border-brand-gray/10 align-top">
                    <td className="py-2 pr-3">
                      <div className="text-brand-black">{piece.returnNumber}</div>
                      <div className="text-xs text-brand-gray">
                        {piece.orderno}
                        {piece.receivedAt && ` · ${format(new Date(piece.receivedAt), "MMM d")}`}
                      </div>
                    </td>
                    <td className="py-2 pr-3">
                      <div>{piece.productName ?? "—"}</div>
                      <div className="text-xs text-brand-gray">{piece.partNo}</div>
                    </td>
                    <td className="py-2 pr-3">{piece.quantity}</td>
                    <td className="py-2 pr-3">
                      {piece.storeName}
                      <div className="text-xs text-brand-gray">{piece.placeName}</div>
                    </td>
                    <td className="py-2 pr-3">
                      {piece.inspectionCondition
                        ? (CONDITION_LABELS[piece.inspectionCondition] ?? piece.inspectionCondition)
                        : "Not inspected"}
                    </td>
                    <td className="py-2 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <label htmlFor={`put-back-${piece.id}`} className="sr-only">
                          Put back at
                        </label>
                        <select
                          id={`put-back-${piece.id}`}
                          value={placeFor[piece.id] ?? ""}
                          onChange={(e) =>
                            setPlaceFor((m) => ({ ...m, [piece.id]: e.target.value }))
                          }
                          className="border border-brand-gray/30 rounded px-2 py-1 text-sm"
                        >
                          <option value="">The store&apos;s receiving place</option>
                          {places.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                        <Button
                          size="sm"
                          disabled={busyId === piece.id}
                          onClick={() =>
                            act(
                              piece,
                              {
                                action: "PUT_BACK",
                                storeLocationId: piece.storeLocationId,
                                stockLocationId: placeFor[piece.id]
                                  ? Number(placeFor[piece.id])
                                  : null,
                              },
                              "Put back on the shelf",
                            )
                          }
                        >
                          Put back
                        </Button>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <label htmlFor={`write-off-${piece.id}`} className="sr-only">
                          Write-off reason
                        </label>
                        <input
                          id={`write-off-${piece.id}`}
                          type="text"
                          value={reasonFor[piece.id] ?? ""}
                          onChange={(e) =>
                            setReasonFor((m) => ({ ...m, [piece.id]: e.target.value }))
                          }
                          placeholder="Reason (optional)"
                          className="border border-brand-gray/30 rounded px-2 py-1 text-sm"
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyId === piece.id}
                          onClick={() =>
                            act(
                              piece,
                              { action: "WRITE_OFF", reason: reasonFor[piece.id] ?? null },
                              "Written off",
                            )
                          }
                        >
                          Write off
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
