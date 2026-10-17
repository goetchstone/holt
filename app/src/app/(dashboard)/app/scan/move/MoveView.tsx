"use client";

// /app/src/app/(dashboard)/app/scan/move/MoveView.tsx
//
// Scan where it is, what is moving, then where it goes. A one-box product's
// tag is one unit; a multi-box product moves by its box labels: whole sets
// move as units, and boxes that make no whole set move on their own and are
// noted as stray where they went (lib/inventory/floorMove.ts).

import { useRef, useState } from "react";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { ScanFrame, type ScanMessage } from "@/components/scan/ScanFrame";
import { getErrorMessage } from "@/lib/toastError";
import { assembleUnits } from "@/lib/inventory/boxes";
import type { ScanResult, ScannedPlace, ScannedProduct } from "@/lib/scan/resolveScan";

interface Item {
  product: ScannedProduct;
  units: number;
  boxes: number[];
}

const newKey = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** Whole units to move, and the boxes left over that move on their own. */
function split(item: Item) {
  const a = assembleUnits(item.product.boxesPerUnit, item.boxes);
  const loose = a.incomplete.flatMap((s) => s.present);
  return { units: item.units + a.units, loose };
}

export function MoveView() {
  const [from, setFrom] = useState<ScannedPlace | null>(null);
  const [to, setTo] = useState<ScannedPlace | null>(null);
  const [items, setItems] = useState<Record<number, Item>>({});
  const [message, setMessage] = useState<ScanMessage | null>(null);
  const [busy, setBusy] = useState(false);
  const keyRef = useRef<string | null>(null);

  const reset = () => {
    setFrom(null);
    setTo(null);
    setItems({});
    keyRef.current = null;
  };

  const onScan = async (code: string, storeLocationId: number | null) => {
    try {
      const res = await axios.get<{ result: ScanResult }>("/api/scan/resolve", {
        params: { code, storeLocationId: storeLocationId ?? undefined },
      });
      const r = res.data.result;
      if (r.kind === "unknown") return setMessage({ tone: "error", text: r.message });
      keyRef.current = null;
      if (r.kind === "place") {
        if (!r.place.holdsStock) {
          return setMessage({
            tone: "error",
            text: `${r.place.path} groups places: scan one inside it.`,
          });
        }
        if (!from) {
          setFrom(r.place);
          return setMessage({ tone: "info", text: `From ${r.place.path}: scan what is moving` });
        }
        if (Object.keys(items).length === 0) {
          setFrom(r.place);
          return setMessage({ tone: "info", text: `From ${r.place.path}: scan what is moving` });
        }
        setTo(r.place);
        return setMessage({ tone: "info", text: `To ${r.place.path}: confirm the move` });
      }
      if (!from)
        return setMessage({ tone: "error", text: "Scan the place it is moving from first." });
      const item = items[r.product.id] ?? { product: r.product, units: 0, boxes: [] };
      if (r.box) {
        setItems({ ...items, [r.product.id]: { ...item, boxes: [...item.boxes, r.box.box] } });
        return setMessage({
          tone: "ok",
          text: `${r.product.name}: box ${r.box.box} of ${r.box.of}`,
        });
      }
      if (r.product.boxesPerUnit > 1) {
        return setMessage({
          tone: "error",
          text: `${r.product.name} ships in ${r.product.boxesPerUnit} boxes: scan its box labels.`,
        });
      }
      setItems({ ...items, [r.product.id]: { ...item, units: item.units + 1 } });
      setMessage({ tone: "ok", text: `${r.product.name}: ${item.units + 1}` });
    } catch (err) {
      setMessage({ tone: "error", text: getErrorMessage(err, "Could not read that scan.") });
    }
  };

  const move = async () => {
    if (!from || !to) return;
    keyRef.current ??= newKey();
    setBusy(true);
    try {
      const list = Object.values(items).map((i) => ({ i, s: split(i) }));
      const res = await axios.post("/api/scan/move", {
        actionKey: keyRef.current,
        fromStockLocationId: from.id,
        toStockLocationId: to.id,
        items: list
          .filter(({ s }) => s.units > 0)
          .map(({ i, s }) => ({ productId: i.product.id, units: s.units })),
        strayBoxes: list
          .filter(({ s }) => s.loose.length > 0)
          .map(({ i, s }) => ({ productId: i.product.id, boxes: s.loose })),
      });
      const d = res.data;
      setMessage({
        tone: "ok",
        text:
          `Moved ${d.units} to ${to.path}` +
          (d.committed ? ` (${d.committed} sold)` : "") +
          (d.strayNotes ? `, ${d.strayNotes} stray box note(s)` : "") +
          (d.reunited ? `, ${d.reunited} box set(s) reunited` : ""),
      });
      reset();
    } catch (err) {
      setMessage({ tone: "error", text: getErrorMessage(err, "Not moved: send it again.") });
    } finally {
      setBusy(false);
    }
  };

  const entries = Object.values(items);
  return (
    <ScanFrame
      title="Put away and move"
      prompt={
        !from
          ? "Scan where it is now"
          : to
            ? "Confirm, or scan more"
            : "Scan items, then where they go"
      }
      onScan={onScan}
      message={message}
    >
      {from && (
        <div className="space-y-2 text-sm">
          <p>
            From <span className="font-medium">{from.path}</span>
            {to && (
              <>
                {" "}
                to <span className="font-medium">{to.path}</span>
              </>
            )}
          </p>
          <ul className="space-y-1">
            {entries.map((i) => {
              const s = split(i);
              return (
                <li
                  key={i.product.id}
                  className="flex justify-between border-b border-brand-gray/10 py-1"
                >
                  <span>{i.product.name}</span>
                  <span>
                    {s.units > 0 && <span className="font-semibold">{s.units}</span>}
                    {s.loose.length > 0 && (
                      <span className="block text-xs text-amber-800">
                        box {s.loose.join(", ")} on its own
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="flex gap-2">
            <Button
              onClick={move}
              disabled={busy || !to || entries.length === 0}
              fullWidth
              className="h-12 text-lg"
            >
              {busy ? "Moving..." : "Move"}
            </Button>
            <Button variant="outline" onClick={reset} disabled={busy}>
              Clear
            </Button>
          </div>
        </div>
      )}
    </ScanFrame>
  );
}
