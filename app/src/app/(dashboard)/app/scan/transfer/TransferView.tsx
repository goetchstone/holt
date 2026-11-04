"use client";

// /app/src/app/(dashboard)/app/scan/transfer/TransferView.tsx
//
// Transfers on the handheld, both ends (GAP-19).
//
// Send: scan where it is, then what is going, then choose the store it goes
// to or scan a place there. It leaves now and is on its way until it is
// received (sendFromPlace, lib/inventory/transfers.ts). A product that ships
// in several boxes goes by its box labels, and only in whole sets.
//
// Receive: what is on its way to this store is listed. Scan what arrived, and
// a place to put it all there instead of where each transfer was sent. Boxes
// that make no whole unit wait for the rest of their set.
//
// Each send or receipt carries an action key, so a resend never moves twice.

import { useCallback, useEffect, useRef, useState } from "react";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { ScanFrame, type ScanMessage } from "@/components/scan/ScanFrame";
import { useStoreLocations } from "@/hooks/useStoreLocations";
import { getErrorMessage } from "@/lib/toastError";
import { tallyUnits } from "@/lib/inventory/boxes";
import type { ScanResult, ScannedPlace, ScannedProduct } from "@/lib/scan/resolveScan";
import type { OnItsWay } from "@/lib/inventory/transfersShared";

type Mode = "send" | "receive";

interface Item {
  product: ScannedProduct;
  units: number;
  boxes: number[];
}

type ProductScan = Extract<ScanResult, { kind: "product" }>;

const newKey = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function promptFor(mode: Mode, from: ScannedPlace | null): string {
  if (mode === "receive") return "Scan what arrived, or a place";
  return from ? "Scan items, then where they go" : "Scan where it is now";
}

/** A product scan added to the tally, or why it can't be. */
function addScan(
  items: Record<number, Item>,
  r: ProductScan,
): { items: Record<number, Item>; text: string } | { error: string } {
  const item = items[r.product.id] ?? { product: r.product, units: 0, boxes: [] };
  if (r.box) {
    return {
      items: { ...items, [r.product.id]: { ...item, boxes: [...item.boxes, r.box.box] } },
      text: `${r.product.name}: box ${r.box.box} of ${r.box.of}`,
    };
  }
  if (r.product.boxesPerUnit > 1) {
    return {
      error: `${r.product.name} ships in ${r.product.boxesPerUnit} boxes: scan its box labels.`,
    };
  }
  return {
    items: { ...items, [r.product.id]: { ...item, units: item.units + 1 } },
    text: `${r.product.name}: ${item.units + 1}`,
  };
}

/** What is on its way, one row per product. */
function byProduct(onWay: OnItsWay[]) {
  const rows = new Map<number, { name: string; remaining: number; from: Set<string> }>();
  for (const t of onWay) {
    const row = rows.get(t.productId) ?? { name: t.name, remaining: 0, from: new Set<string>() };
    row.remaining += t.remaining;
    row.from.add(t.orderNo ? `${t.from} (${t.orderNo})` : t.from);
    rows.set(t.productId, row);
  }
  return [...rows].map(([productId, r]) => ({ productId, ...r, from: [...r.from].join(", ") }));
}

export function TransferView() {
  const [mode, setMode] = useState<Mode>("send");
  const [storeId, setStoreId] = useState<number | null>(null);
  const { stores } = useStoreLocations();
  const [from, setFrom] = useState<ScannedPlace | null>(null);
  const [toStoreId, setToStoreId] = useState<number | null>(null);
  const [toPlace, setToPlace] = useState<ScannedPlace | null>(null);
  const [onWay, setOnWay] = useState<OnItsWay[] | null>(null);
  const [into, setInto] = useState<ScannedPlace | null>(null);
  const [items, setItems] = useState<Record<number, Item>>({});
  const [message, setMessage] = useState<ScanMessage | null>(null);
  const [busy, setBusy] = useState(false);
  const keyRef = useRef<string | null>(null);

  const clear = () => {
    setFrom(null);
    setToStoreId(null);
    setToPlace(null);
    setInto(null);
    setItems({});
    keyRef.current = null;
  };

  // A promise chain rather than an awaited call, so the effect sets no state
  // synchronously (react-hooks/set-state-in-effect).
  const loadOnWay = useCallback(
    (store: number) =>
      axios
        .get<{ transfers: OnItsWay[] }>("/api/scan/transfer/receive", {
          params: { storeLocationId: store },
        })
        .then((res) => setOnWay(res.data.transfers))
        .catch((err: unknown) =>
          setMessage({
            tone: "error",
            text: getErrorMessage(err, "Could not load what is on its way."),
          }),
        ),
    [],
  );

  useEffect(() => {
    if (mode === "receive" && storeId != null) void loadOnWay(storeId);
  }, [mode, storeId, loadOnWay]);

  const switchTo = (next: Mode) => {
    clear();
    setMessage(null);
    setMode(next);
  };

  const sendPlace = (place: ScannedPlace) => {
    if (!from || Object.keys(items).length === 0) {
      setFrom(place);
      return setMessage({ tone: "info", text: `From ${place.path}: scan what is going` });
    }
    setToPlace(place);
    setToStoreId(place.storeLocationId);
    setMessage({ tone: "info", text: `To ${place.path} at ${place.storeName}: send it` });
  };

  const receivePlace = (place: ScannedPlace) => {
    if (place.storeLocationId !== storeId) {
      return setMessage({ tone: "error", text: `${place.path} is at ${place.storeName}.` });
    }
    setInto(place);
    setMessage({ tone: "info", text: `Putting it all in ${place.path}` });
  };

  const onScan = async (code: string, storeLocationId: number | null) => {
    try {
      const res = await axios.get<{ result: ScanResult }>("/api/scan/resolve", {
        params: { code, storeLocationId: storeLocationId ?? undefined },
      });
      const r = res.data.result;
      if (r.kind === "unknown") return setMessage({ tone: "error", text: r.message });
      keyRef.current = null; // what is being sent changed: a new action
      if (r.kind === "place") {
        if (!r.place.holdsStock) {
          return setMessage({
            tone: "error",
            text: `${r.place.path} groups places: scan one inside it.`,
          });
        }
        return mode === "send" ? sendPlace(r.place) : receivePlace(r.place);
      }
      if (mode === "send" && !from) {
        return setMessage({ tone: "error", text: "Scan the place it is leaving from first." });
      }
      if (mode === "receive" && !onWay?.some((t) => t.productId === r.product.id)) {
        return setMessage({ tone: "error", text: `${r.product.name} isn't on its way here.` });
      }
      const added = addScan(items, r);
      if ("error" in added) return setMessage({ tone: "error", text: added.error });
      setItems(added.items);
      setMessage({ tone: "ok", text: added.text });
    } catch (err) {
      setMessage({ tone: "error", text: getErrorMessage(err, "Could not read that scan.") });
    }
  };

  const tallies = Object.values(items).map((i) => ({
    i,
    t: tallyUnits(i.product.boxesPerUnit, i),
  }));
  const whole = tallies
    .filter(({ t }) => t.units > 0)
    .map(({ i, t }) => ({ productId: i.product.id, units: t.units }));
  const loose = tallies.filter(({ t }) => t.loose.length > 0);
  const units = whole.reduce((sum, w) => sum + w.units, 0);
  const toName = toPlace?.storeName ?? stores.find((s) => s.id === toStoreId)?.name;
  const sendLabel = toName ? `Send to ${toName}` : "Send";

  const send = async () => {
    if (!from || toStoreId == null) return;
    keyRef.current ??= newKey();
    setBusy(true);
    try {
      const res = await axios.post("/api/scan/transfer/send", {
        actionKey: keyRef.current,
        fromStockLocationId: from.id,
        toLocationId: toStoreId,
        toStockLocationId: toPlace?.id,
        items: whole,
      });
      const d = res.data;
      const to = toPlace?.path ?? toName ?? "the store";
      setMessage({
        tone: "ok",
        text:
          `Sent ${d.units} to ${to}` +
          (d.committed ? ` (${d.committed} sold)` : "") +
          ": on its way until it is received there",
      });
      clear();
    } catch (err) {
      // The key is kept: sending again is the same action, never a second transfer.
      setMessage({ tone: "error", text: getErrorMessage(err, "Not sent: send it again.") });
    } finally {
      setBusy(false);
    }
  };

  const receive = async () => {
    if (storeId == null) return setMessage({ tone: "error", text: "Choose the store first." });
    keyRef.current ??= newKey();
    setBusy(true);
    try {
      const res = await axios.post("/api/scan/transfer/receive", {
        actionKey: keyRef.current,
        storeLocationId: storeId,
        toStockLocationId: into?.id,
        items: whole,
      });
      const d = res.data;
      setMessage({
        tone: "ok",
        text:
          `Received ${d.units}` +
          (d.completed ? `; ${plural(d.completed, "transfer", "transfers")} complete` : "") +
          (loose.length ? "; boxes without their whole set wait for the rest" : ""),
      });
      clear();
      await loadOnWay(storeId);
    } catch (err) {
      setMessage({ tone: "error", text: getErrorMessage(err, "Not received: send it again.") });
    } finally {
      setBusy(false);
    }
  };

  const tally = (productId: number) => tallies.find(({ i }) => i.product.id === productId)?.t;

  return (
    <ScanFrame
      title="Transfer"
      prompt={promptFor(mode, from)}
      onScan={onScan}
      message={message}
      onStoreChange={setStoreId}
    >
      <div className="grid grid-cols-2 gap-2">
        {(["send", "receive"] as const).map((m) => (
          <Button
            key={m}
            variant={mode === m ? "primary" : "outline"}
            onClick={() => switchTo(m)}
            disabled={busy}
          >
            {m === "send" ? "Send" : "Receive"}
          </Button>
        ))}
      </div>

      {mode === "send" && from && (
        <div className="space-y-2 text-sm">
          <p>
            From <span className="font-medium">{from.path}</span>
          </p>
          <ul className="space-y-1">
            {tallies.map(({ i, t }) => (
              <li
                key={i.product.id}
                className="flex justify-between border-b border-brand-gray/10 py-1"
              >
                <span>{i.product.name}</span>
                <span className="text-right">
                  {t.units > 0 && <span className="font-semibold">{t.units}</span>}
                  {t.loose.length > 0 && (
                    <span className="block text-xs text-amber-800">
                      box {t.loose.join(", ")} without its whole set
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {loose.length > 0 && (
            <p className="text-amber-800">
              A transfer sends whole sets: scan the rest of the boxes, or clear and start again.
            </p>
          )}
          <label className="block">
            <span className="block text-brand-gray">To</span>
            <select
              aria-label="Store it goes to"
              value={toStoreId ?? ""}
              onChange={(e) => {
                setToStoreId(e.target.value ? Number(e.target.value) : null);
                setToPlace(null);
                keyRef.current = null;
              }}
              className="w-full border border-brand-gray/30 rounded px-2 py-2"
            >
              <option value="">Choose a store</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            {toPlace && <span className="block mt-1">Into {toPlace.path}</span>}
          </label>
          <div className="flex gap-2">
            <Button
              onClick={send}
              disabled={busy || toStoreId == null || whole.length === 0 || loose.length > 0}
              fullWidth
              className="h-12 text-lg"
            >
              {busy ? "Sending..." : sendLabel}
            </Button>
            <Button variant="outline" onClick={clear} disabled={busy}>
              Clear
            </Button>
          </div>
        </div>
      )}

      {mode === "receive" && onWay && (
        <div className="space-y-2 text-sm">
          {onWay.length === 0 ? (
            <p className="text-brand-gray">Nothing is on its way to this store.</p>
          ) : (
            <table className="w-full">
              <tbody>
                {byProduct(onWay).map((row) => {
                  const t = tally(row.productId);
                  return (
                    <tr key={row.productId} className="border-b border-brand-gray/10 align-top">
                      <td className="py-1 pr-2">
                        {row.name}
                        <span className="block text-xs text-brand-gray">from {row.from}</span>
                        {t && t.loose.length > 0 && (
                          <span className="block text-xs text-amber-800">
                            box {t.loose.join(", ")} waiting for the rest of its set
                          </span>
                        )}
                      </td>
                      <td className="py-1 text-right whitespace-nowrap">
                        <span className="text-lg font-semibold">{t?.units || ""}</span>
                        <span className="block text-xs text-brand-gray">
                          {row.remaining} on the way
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {into && <p>Into: {into.path}</p>}
          <div className="flex gap-2">
            <Button
              onClick={receive}
              disabled={busy || whole.length === 0}
              fullWidth
              className="h-12 text-lg"
            >
              {busy ? "Receiving..." : `Receive ${units || ""}`.trim()}
            </Button>
            {Object.keys(items).length > 0 && (
              <Button variant="outline" onClick={clear} disabled={busy}>
                Clear
              </Button>
            )}
          </div>
        </div>
      )}
    </ScanFrame>
  );
}
