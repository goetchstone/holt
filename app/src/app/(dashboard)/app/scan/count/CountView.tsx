"use client";

// /app/src/app/(dashboard)/app/scan/count/CountView.tsx
//
// Scan the place, then everything in it. A one-box product's tag counts one;
// a multi-box product is counted by its box labels (whole sets), and boxes
// that make no whole set are shown so the counter can say whether that unit
// is here. Counting "everything here" says what is not here too; "only these"
// is a quick count of what was scanned. The counter submits; someone with
// Adjust inventory posts (or the counter does, if they have it).

import { useRef, useState } from "react";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { ScanFrame, type ScanMessage } from "@/components/scan/ScanFrame";
import { getErrorMessage } from "@/lib/toastError";
import { assembleUnits } from "@/lib/inventory/boxes";
import type { ScanResult, ScannedPlace, ScannedProduct } from "@/lib/scan/resolveScan";

interface Line {
  product: ScannedProduct;
  units: number;
  boxes: number[];
}

const newKey = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function countedOf(line: Line) {
  const a = assembleUnits(line.product.boxesPerUnit, line.boxes);
  return { counted: line.units + a.units, partial: a.incomplete };
}

export function CountView() {
  const [place, setPlace] = useState<ScannedPlace | null>(null);
  const [lines, setLines] = useState<Record<number, Line>>({});
  const [scope, setScope] = useState<"PLACE" | "PRODUCTS">("PLACE");
  const [message, setMessage] = useState<ScanMessage | null>(null);
  const [busy, setBusy] = useState(false);
  const keyRef = useRef<string | null>(null);
  const storeRef = useRef<number | null>(null);

  const change = (next: Record<number, Line>) => {
    keyRef.current = null;
    setLines(next);
  };

  const onScan = async (code: string, storeLocationId: number | null) => {
    storeRef.current = storeLocationId;
    try {
      const res = await axios.get<{ result: ScanResult }>("/api/scan/resolve", {
        params: { code, storeLocationId: storeLocationId ?? undefined },
      });
      const r = res.data.result;
      if (r.kind === "unknown") return setMessage({ tone: "error", text: r.message });
      if (r.kind === "place") {
        if (!r.place.holdsStock) {
          return setMessage({
            tone: "error",
            text: `${r.place.path} groups places: count each one.`,
          });
        }
        if (place && place.id !== r.place.id && Object.keys(lines).length > 0) {
          return setMessage({
            tone: "error",
            text: "Submit or clear this count before the next place.",
          });
        }
        setPlace(r.place);
        return setMessage({ tone: "info", text: `Counting ${r.place.path}` });
      }
      if (!place) return setMessage({ tone: "error", text: "Scan the place first." });
      const line = lines[r.product.id] ?? { product: r.product, units: 0, boxes: [] };
      if (r.box) {
        change({ ...lines, [r.product.id]: { ...line, boxes: [...line.boxes, r.box.box] } });
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
      change({ ...lines, [r.product.id]: { ...line, units: line.units + 1 } });
      setMessage({ tone: "ok", text: `${r.product.name}: ${line.units + 1}` });
    } catch (err) {
      setMessage({ tone: "error", text: getErrorMessage(err, "Could not read that scan.") });
    }
  };

  const bump = (productId: number, by: number) => {
    const line = lines[productId];
    if (!line) return;
    change({ ...lines, [productId]: { ...line, units: Math.max(0, line.units + by) } });
  };

  const submit = async (post: boolean) => {
    if (!place || storeRef.current == null) return;
    keyRef.current ??= newKey();
    setBusy(true);
    try {
      const res = await axios.post("/api/scan/count", {
        actionKey: keyRef.current,
        storeLocationId: storeRef.current,
        stockLocationId: place.id,
        scope,
        post,
        lines: Object.values(lines).map((l) => ({
          productId: l.product.id,
          counted: countedOf(l).counted,
          boxes: l.boxes,
        })),
      });
      setMessage({
        tone: "ok",
        text: res.data.posted
          ? `Count posted: ${res.data.changed} product(s) changed`
          : "Count submitted for posting",
      });
      setLines({});
      setPlace(null);
      keyRef.current = null;
    } catch (err) {
      setMessage({ tone: "error", text: getErrorMessage(err, "Not submitted: send it again.") });
    } finally {
      setBusy(false);
    }
  };

  const entries = Object.values(lines);
  return (
    <ScanFrame
      title="Count"
      prompt={place ? "Scan products or box labels" : "Scan the place to count"}
      onScan={onScan}
      message={message}
    >
      {place && (
        <div className="space-y-2">
          <p className="text-sm">
            <span className="font-medium">{place.path}</span>
          </p>
          <div className="flex gap-3 text-sm">
            <label className="flex items-center gap-1">
              <input type="radio" checked={scope === "PLACE"} onChange={() => setScope("PLACE")} />
              Everything here
            </label>
            <label className="flex items-center gap-1">
              <input
                type="radio"
                checked={scope === "PRODUCTS"}
                onChange={() => setScope("PRODUCTS")}
              />
              Only what I scan
            </label>
          </div>
          <table className="w-full text-sm">
            <tbody>
              {entries.map((l) => {
                const c = countedOf(l);
                return (
                  <tr key={l.product.id} className="border-b border-brand-gray/10 align-top">
                    <td className="py-1 pr-2">
                      {l.product.name}
                      {c.partial.map((p, i) => (
                        <span key={i} className="block text-xs text-amber-800">
                          Boxes {p.present.join(", ")} of {l.product.boxesPerUnit} only{" "}
                          <button className="underline" onClick={() => bump(l.product.id, 1)}>
                            count that unit here
                          </button>
                        </span>
                      ))}
                    </td>
                    <td className="py-1 text-right whitespace-nowrap">
                      <button
                        className="px-2"
                        onClick={() => bump(l.product.id, -1)}
                        aria-label="One fewer"
                      >
                        −
                      </button>
                      <span className="text-lg font-semibold">{c.counted}</span>
                      <button
                        className="px-2"
                        onClick={() => bump(l.product.id, 1)}
                        aria-label="One more"
                      >
                        +
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {scope === "PLACE" && (
            <p className="text-xs text-brand-gray">
              Anything on the books here that you did not scan is counted as not here.
            </p>
          )}
          <div className="flex gap-2">
            <Button onClick={() => submit(false)} disabled={busy} fullWidth className="h-12">
              Submit count
            </Button>
            <Button variant="outline" onClick={() => submit(true)} disabled={busy} className="h-12">
              Submit and post
            </Button>
          </div>
          <button
            className="text-sm text-brand-gray underline"
            onClick={() => {
              setLines({});
              setPlace(null);
            }}
          >
            Clear this count
          </button>
        </div>
      )}
    </ScanFrame>
  );
}
