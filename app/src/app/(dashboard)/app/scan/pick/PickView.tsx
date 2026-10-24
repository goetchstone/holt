"use client";

// /app/src/app/(dashboard)/app/scan/pick/PickView.tsx
//
// Choose the run, scan the loading bay, then pick what the pull list asks for:
// a one-box product per scan, a multi-box one by every box of the unit (an
// incomplete set is refused). Each pick moves the unit to the bay, still the
// customer's, and the list shrinks. Load the truck when nothing is left: the
// bay's units go onto the run's truck. When the truck comes back with what
// could not be delivered, scan the bay and unload it there.

import { useCallback, useEffect, useRef, useState } from "react";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { ScanFrame, type ScanMessage } from "@/components/scan/ScanFrame";
import { getErrorMessage } from "@/lib/toastError";
import { assembleUnits, BoxError } from "@/lib/inventory/boxes";
import type { ScanResult, ScannedPlace } from "@/lib/scan/resolveScan";

interface Run {
  id: number;
  runNumber: string;
  runDate: string;
  status: string;
  stops?: number;
}

interface Row {
  salesOrderId: number;
  orderno: string;
  productId: number;
  productName: string;
  productNumber: string;
  boxesPerUnit: number;
  quantity: number;
  fromStoreLocationId: number | null;
  fromStockLocationId: number | null;
  fromPath: string | null;
  crossSite: boolean;
}

/** A row needs a transfer first: once the bay is scanned, if it is at another store. */
function needsTransfer(r: Row, bay: ScannedPlace | null): boolean {
  if (r.fromStoreLocationId == null) return false;
  return bay ? r.fromStoreLocationId !== bay.storeLocationId : r.crossSite;
}

interface Stray {
  noteId: number;
  productId: number;
  boxes: number[];
  placePath: string;
}

interface Aboard {
  storeLocationId: number;
  orderno: string;
  productName: string;
  quantity: number;
}

const newKey = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function PickView() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [strays, setStrays] = useState<Stray[]>([]);
  const [aboard, setAboard] = useState<Aboard[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [bay, setBay] = useState<ScannedPlace | null>(null);
  const [boxes, setBoxes] = useState<Record<number, number[]>>({});
  const [message, setMessage] = useState<ScanMessage | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    axios
      .get<{ runs: Run[] }>("/api/scan/pick")
      .then((r) => setRuns(r.data.runs))
      .catch((err) =>
        setMessage({ tone: "error", text: getErrorMessage(err, "Could not load runs.") }),
      );
  }, []);

  const loadRun = useCallback(async (runId: number) => {
    const r = await axios.get<{
      run: Run;
      rows: Row[];
      strays: Stray[];
      notes: string[];
      aboard: Aboard[];
    }>("/api/scan/pick", { params: { runId } });
    setRun(r.data.run);
    setRows(r.data.rows);
    setStrays(r.data.strays);
    setNotes(r.data.notes);
    setAboard(r.data.aboard);
  }, []);

  const pick = async (row: Row, units: number, pickedBoxes?: number[]) => {
    if (!run || !bay || row.fromStockLocationId == null) return;
    busy.current = true;
    try {
      const res = await axios.post("/api/scan/pick", {
        actionKey: newKey(),
        deliveryRunId: run.id,
        salesOrderId: row.salesOrderId,
        productId: row.productId,
        units,
        fromStockLocationId: row.fromStockLocationId,
        toStockLocationId: bay.id,
        boxes: pickedBoxes,
      });
      setMessage({
        tone: "ok",
        text:
          `${row.productName} for ${row.orderno} to ${bay.name}` +
          (res.data.reunitedBoxes ? ` (stray box reunited)` : ""),
      });
      await loadRun(run.id);
    } catch (err) {
      setMessage({ tone: "error", text: getErrorMessage(err, "Not picked.") });
    } finally {
      busy.current = false;
    }
  };

  const onScan = async (code: string, storeLocationId: number | null) => {
    if (!run || busy.current) return;
    try {
      const res = await axios.get<{ result: ScanResult }>("/api/scan/resolve", {
        params: { code, storeLocationId: storeLocationId ?? undefined },
      });
      const r = res.data.result;
      if (r.kind === "unknown") return setMessage({ tone: "error", text: r.message });
      if (r.kind === "place") {
        if (r.place.locationType !== "STAGING") {
          return setMessage({
            tone: "error",
            text: `${r.place.path} is not a staging place (a loading bay).`,
          });
        }
        setBay(r.place);
        return setMessage({ tone: "info", text: `Picking to ${r.place.path}` });
      }
      if (!bay) return setMessage({ tone: "error", text: "Scan the loading bay first." });
      const row = rows.find((x) => x.productId === r.product.id && x.fromStockLocationId != null);
      if (!row)
        return setMessage({ tone: "error", text: `Nothing left to pick of ${r.product.name}.` });
      if (row.boxesPerUnit === 1) return pick(row, 1);
      if (!r.box) {
        return setMessage({
          tone: "error",
          text: `${r.product.name} ships in boxes: scan each box label.`,
        });
      }
      const got = [...(boxes[r.product.id] ?? []), r.box.box];
      let a;
      try {
        a = assembleUnits(row.boxesPerUnit, got);
      } catch (err) {
        return setMessage({
          tone: "error",
          text: err instanceof BoxError ? err.message : "Bad box",
        });
      }
      if (a.units >= 1 && a.incomplete.length === 0) {
        setBoxes({ ...boxes, [r.product.id]: [] });
        return pick(row, a.units, got);
      }
      setBoxes({ ...boxes, [r.product.id]: got });
      const missing = a.incomplete[0]?.missing ?? [];
      setMessage({
        tone: "info",
        text: `${r.product.name}: box ${r.box.box}; still need box ${missing.join(", ")}`,
      });
    } catch (err) {
      setMessage({ tone: "error", text: getErrorMessage(err, "Could not read that scan.") });
    }
  };

  const loadTruck = async () => {
    if (!run) return;
    try {
      await axios.post("/api/scan/pick", {
        actionKey: newKey(),
        deliveryRunId: run.id,
        load: true,
      });
      setMessage({ tone: "ok", text: `${run.runNumber} loaded` });
      await loadRun(run.id);
    } catch (err) {
      setMessage({ tone: "error", text: getErrorMessage(err, "Not loaded.") });
    }
  };

  const unloadTruck = async () => {
    if (!run || !bay) return;
    try {
      const res = await axios.post("/api/scan/pick", {
        actionKey: newKey(),
        deliveryRunId: run.id,
        unload: true,
        toStockLocationId: bay.id,
      });
      setMessage({ tone: "ok", text: `${res.data.units} unloaded to ${bay.name}` });
      await loadRun(run.id);
    } catch (err) {
      setMessage({ tone: "error", text: getErrorMessage(err, "Not unloaded.") });
    }
  };

  const unloadHere = bay ? aboard.filter((a) => a.storeLocationId === bay.storeLocationId) : [];

  return (
    <ScanFrame
      title="Pick and load"
      prompt={!run ? "Choose a run below" : bay ? "Scan what you pick" : "Scan the loading bay"}
      onScan={onScan}
      message={message}
      scanEnabled={run != null}
    >
      {!run && (
        <div className="space-y-2">
          {runs.length === 0 && <p className="text-sm text-brand-gray">No runs to pick.</p>}
          {runs.map((r) => (
            <Button key={r.id} variant="outline" fullWidth onClick={() => void loadRun(r.id)}>
              {r.runNumber} · {r.runDate.slice(0, 10)} · {r.status.toLowerCase()}
            </Button>
          ))}
        </div>
      )}
      {run && (
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="font-medium">
              {run.runNumber} · {run.status.toLowerCase()}
            </span>
            <button className="text-brand-blue underline" onClick={() => setRun(null)}>
              Another run
            </button>
          </div>
          {notes.map((n) => (
            <p key={n} className="text-amber-800">
              {n}
            </p>
          ))}
          <ul className="space-y-1">
            {rows.map((r, i) => (
              <li key={i} className="border-b border-brand-gray/10 py-1">
                <span className="font-medium">
                  {r.quantity} × {r.productName}
                </span>{" "}
                <span className="text-brand-gray">for {r.orderno}</span>
                <span className="block text-xs">
                  {r.fromPath ? `at ${r.fromPath}` : "nothing to pull: short"}
                  {needsTransfer(r, bay) ? " · at another store: transfer it first" : ""}
                </span>
                {strays
                  .filter((s) => s.productId === r.productId)
                  .map((s) => (
                    <span key={s.noteId} className="block text-xs text-amber-800">
                      Box {s.boxes.join(", ")} is at {s.placePath}
                    </span>
                  ))}
              </li>
            ))}
          </ul>
          {rows.length === 0 && aboard.length === 0 && (
            <p className="text-green-800">Everything is at the loading bay.</p>
          )}
          {aboard.length > 0 && (
            <div className="space-y-1">
              <p className="font-medium">On the truck</p>
              <ul className="space-y-1">
                {aboard.map((a, i) => (
                  <li key={i} className="border-b border-brand-gray/10 py-1">
                    {a.quantity} × {a.productName}{" "}
                    <span className="text-brand-gray">for {a.orderno}</span>
                  </li>
                ))}
              </ul>
              {/* Back from the run, unloading is the job; before it leaves, it
                  is for taking off what should not go. */}
              <Button
                onClick={unloadTruck}
                fullWidth
                variant={run.status === "IN_PROGRESS" ? "primary" : "outline"}
                className="h-12 text-lg"
                disabled={unloadHere.length === 0}
              >
                {bay ? `Unload to ${bay.name}` : "Scan the loading bay to unload"}
              </Button>
            </div>
          )}
          {run.status !== "IN_PROGRESS" && (
            <Button
              onClick={loadTruck}
              fullWidth
              className="h-12 text-lg"
              disabled={run.status === "LOADED"}
            >
              {run.status === "LOADED" ? "Loaded" : "Load the truck"}
            </Button>
          )}
        </div>
      )}
    </ScanFrame>
  );
}
