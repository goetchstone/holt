"use client";

// /app/src/app/(dashboard)/app/scan/receive/ReceiveView.tsx
//
// Scan the PO, then what arrived. A one-box product's tag counts one unit. A
// product that ships in several boxes is counted by its boxes: print its box
// labels first ("Box 2 of 3"), put one on each box, and scan those
// (lib/inventory/boxes.ts assembles boxes into units). Its own tag is not
// counted, because the same manufacturer barcode is often on every box.
// Boxes that make no whole unit are received as incomplete sets into
// quarantine; a box a waiting set was missing completes it. Scan a place to
// put everything there instead of the store's receiving place. One submit,
// sent with an action key so a resend never receives twice.

import { useCallback, useRef, useState } from "react";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { ScanFrame, type ScanMessage } from "@/components/scan/ScanFrame";
import { getErrorMessage } from "@/lib/toastError";
import { assembleUnits, BoxError } from "@/lib/inventory/boxes";
import type { ScanResult, ScannedPlace } from "@/lib/scan/resolveScan";

interface PoLine {
  purchaseOrderItemId: number;
  productId: number | null;
  productNumber: string;
  name: string;
  boxesPerUnit: number;
  ordered: number;
  received: number;
}

interface OpenSet {
  noteId: number;
  productId: number;
  missing: number[];
  fromThisPo: boolean;
}

interface Po {
  po: { id: number; poNumber: string; status: string; vendor: string; open: boolean };
  lines: PoLine[];
  incompleteSets: OpenSet[];
}

interface Tally {
  units: number;
  boxes: number[];
}

const newKey = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function preview(line: PoLine, t: Tally | undefined) {
  if (!t) return { units: 0, incomplete: [] as { missing: number[] }[], error: null };
  try {
    const a = assembleUnits(line.boxesPerUnit, t.boxes);
    return { units: t.units + a.units, incomplete: a.incomplete, error: null };
  } catch (err) {
    return {
      units: t.units,
      incomplete: [],
      error: err instanceof BoxError ? err.message : "Bad box",
    };
  }
}

export function ReceiveView() {
  const [po, setPo] = useState<Po | null>(null);
  const [tallies, setTallies] = useState<Record<number, Tally>>({});
  const [completions, setCompletions] = useState<Record<number, number[]>>({});
  const [place, setPlace] = useState<ScannedPlace | null>(null);
  const [message, setMessage] = useState<ScanMessage | null>(null);
  const [busy, setBusy] = useState(false);
  const keyRef = useRef<string | null>(null);
  const storeRef = useRef<number | null>(null);

  const reset = () => {
    setTallies({});
    setCompletions({});
    setPlace(null);
    keyRef.current = null;
  };

  const loadPo = useCallback(async (code: string, storeLocationId: number | null) => {
    try {
      const res = await axios.get<Po>("/api/scan/receive", {
        params: { po: code, storeLocationId: storeLocationId ?? undefined },
      });
      setPo(res.data);
      reset();
      setMessage(
        res.data.po.open
          ? { tone: "ok", text: `${res.data.po.poNumber} from ${res.data.po.vendor}` }
          : { tone: "error", text: `${res.data.po.poNumber} is ${res.data.po.status}` },
      );
    } catch (err) {
      setMessage({ tone: "error", text: getErrorMessage(err, "No such purchase order.") });
    }
  }, []);

  const onScan = async (code: string, storeLocationId: number | null) => {
    storeRef.current = storeLocationId;
    if (!po) return loadPo(code, storeLocationId);
    keyRef.current = null; // what is being sent changed: a new action
    try {
      const res = await axios.get<{ result: ScanResult }>("/api/scan/resolve", {
        params: { code, storeLocationId: storeLocationId ?? undefined },
      });
      const r = res.data.result;
      if (r.kind === "unknown") return setMessage({ tone: "error", text: r.message });
      if (r.kind === "place") {
        setPlace(r.place);
        return setMessage({ tone: "info", text: `Putting it all in ${r.place.path}` });
      }
      const line = po.lines.find((l) => l.productId === r.product.id);
      if (!line) {
        return setMessage({
          tone: "error",
          text: `${r.product.name} is not on ${po.po.poNumber}.`,
        });
      }
      if (r.box) {
        const used = completions;
        const set = po.incompleteSets.find(
          (s) =>
            s.productId === r.product.id &&
            s.missing.filter((b) => b === r.box!.box).length >
              (used[s.noteId] ?? []).filter((b) => b === r.box!.box).length,
        );
        if (set) {
          setCompletions({ ...used, [set.noteId]: [...(used[set.noteId] ?? []), r.box.box] });
          return setMessage({
            tone: "ok",
            text: `Box ${r.box.box} completes a ${r.product.name} waiting for it`,
          });
        }
        const t = tallies[line.purchaseOrderItemId] ?? { units: 0, boxes: [] };
        setTallies({
          ...tallies,
          [line.purchaseOrderItemId]: { ...t, boxes: [...t.boxes, r.box.box] },
        });
        return setMessage({
          tone: "ok",
          text: `${r.product.name}: box ${r.box.box} of ${r.box.of}`,
        });
      }
      if (line.boxesPerUnit > 1) {
        return setMessage({
          tone: "error",
          text: `${r.product.name} ships in ${line.boxesPerUnit} boxes: print its box labels and scan those.`,
        });
      }
      addUnit(line);
    } catch (err) {
      setMessage({ tone: "error", text: getErrorMessage(err, "Could not read that scan.") });
    }
  };

  const addUnit = (line: PoLine) => {
    keyRef.current = null;
    const t = tallies[line.purchaseOrderItemId] ?? { units: 0, boxes: [] };
    setTallies({ ...tallies, [line.purchaseOrderItemId]: { ...t, units: t.units + 1 } });
    setMessage({ tone: "ok", text: `${line.name}: ${t.units + 1} whole` });
  };

  const submit = async () => {
    if (!po || storeRef.current == null) {
      return setMessage({ tone: "error", text: "Choose the store first." });
    }
    keyRef.current ??= newKey();
    setBusy(true);
    try {
      const res = await axios.post("/api/scan/receive", {
        actionKey: keyRef.current,
        purchaseOrderId: po.po.id,
        storeLocationId: storeRef.current,
        toStockLocationId: place?.id,
        lines: Object.entries(tallies).map(([id, t]) => ({
          purchaseOrderItemId: Number(id),
          units: t.units,
          boxes: t.boxes,
        })),
        completeSets: Object.entries(completions).map(([noteId, boxes]) => ({
          noteId: Number(noteId),
          boxes,
        })),
      });
      const d = res.data;
      reset();
      // Reload the PO first: loading it shows its own header, which would
      // otherwise replace the confirmation.
      await loadPo(po.po.poNumber, storeRef.current);
      setMessage({
        tone: "ok",
        text:
          `Received ${d.units}` +
          (d.incompleteSets ? `, ${d.incompleteSets} incomplete set(s) to quarantine` : "") +
          (d.completedSets ? `, ${d.completedSets} set(s) completed` : ""),
      });
    } catch (err) {
      // The key is kept: sending again is the same action, never a second receipt.
      setMessage({ tone: "error", text: getErrorMessage(err, "Not received: send it again.") });
    } finally {
      setBusy(false);
    }
  };

  const printLabels = async (line: PoLine, units: number) => {
    try {
      const res = await axios.post("/api/scan/box-labels", {
        productId: line.productId,
        units,
        purchaseOrderId: po?.po.id,
        storeLocationId: storeRef.current,
      });
      setMessage({ tone: "ok", text: `${res.data.printed} box labels printing` });
    } catch (err) {
      setMessage({ tone: "error", text: getErrorMessage(err, "The labels did not print.") });
    }
  };

  const scanned = Object.keys(tallies).length + Object.keys(completions).length > 0;

  return (
    <ScanFrame
      title="Receive"
      prompt={po ? "Scan products, box labels or a place" : "Scan or type the PO number"}
      onScan={onScan}
      message={message}
    >
      {po && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">{po.po.poNumber}</span>
            <button className="text-brand-blue underline" onClick={() => setPo(null)}>
              Another PO
            </button>
          </div>
          {place && <p className="text-sm">Into: {place.path}</p>}
          <table className="w-full text-sm">
            <tbody>
              {po.lines.map((line) => {
                const p = preview(line, tallies[line.purchaseOrderItemId]);
                return (
                  <tr
                    key={line.purchaseOrderItemId}
                    className="border-b border-brand-gray/10 align-top"
                  >
                    <td className="py-1 pr-2">
                      {line.name}
                      <span className="block text-xs text-brand-gray">
                        {line.productNumber}
                        {line.boxesPerUnit > 1 ? ` · ${line.boxesPerUnit} boxes` : ""}
                      </span>
                      {p.incomplete.map((s, i) => (
                        <span key={i} className="block text-xs text-amber-800">
                          Incomplete: missing box {s.missing.join(", ")}
                        </span>
                      ))}
                      {p.error && <span className="block text-xs text-red-700">{p.error}</span>}
                    </td>
                    <td className="py-1 text-right whitespace-nowrap">
                      <span className="text-lg font-semibold">{p.units || ""}</span>
                      <span className="block text-xs text-brand-gray">
                        {line.received}/{line.ordered}
                      </span>
                      {line.boxesPerUnit > 1 && (
                        <span className="flex gap-1 justify-end mt-1">
                          <button
                            className="text-xs border border-brand-gray/30 rounded px-2 py-1"
                            onClick={() =>
                              printLabels(
                                line,
                                Math.max(1, Math.ceil(line.ordered - line.received)),
                              )
                            }
                          >
                            Labels
                          </button>
                          <button
                            className="text-xs border border-brand-gray/30 rounded px-2 py-1"
                            onClick={() => addUnit(line)}
                            title="Every box of one unit is here"
                          >
                            +1 whole
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {Object.keys(completions).length > 0 && (
            <p className="text-sm text-green-800">
              Completing {Object.keys(completions).length} waiting set(s)
            </p>
          )}
          <div className="flex gap-2">
            <Button onClick={submit} disabled={busy || !scanned} fullWidth className="h-12 text-lg">
              {busy ? "Receiving..." : "Receive"}
            </Button>
            {scanned && (
              <Button variant="outline" onClick={reset} disabled={busy}>
                Clear
              </Button>
            )}
          </div>
        </div>
      )}
    </ScanFrame>
  );
}
