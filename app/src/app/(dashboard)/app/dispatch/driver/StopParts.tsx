"use client";

// /app/src/app/(dashboard)/app/dispatch/driver/StopParts.tsx
//
// Pieces of a driver's stop card (ledger plan phase 20): what the stop is
// about (the order's goods, or the return being collected), the delivered
// count per line when completing, and the "Couldn't deliver" form.

import { useState } from "react";
import type { OpenLine } from "@/lib/fulfilment/deliveredLines";

export interface StopReturn {
  returnNumber: string;
  productName: string | null;
  quantity: number | string;
  status: string;
}

export function PickupItems({ ret }: { ret: StopReturn }) {
  return (
    <div className="mt-2 bg-brand-linen rounded-lg p-3">
      <p className="text-xs font-semibold text-brand-gray uppercase tracking-wide mb-1">
        Collect (return {ret.returnNumber})
      </p>
      <div className="text-sm text-brand-navy">
        {ret.productName || "Returned item"}
        {Number(ret.quantity) !== 1 && (
          <span className="text-brand-gray ml-1">x{Number(ret.quantity)}</span>
        )}
      </div>
    </div>
  );
}

export function DeliveredCounts({
  lines,
  counts,
  onChange,
}: {
  lines: OpenLine[];
  counts: Record<number, number>;
  onChange: (lineId: number, quantity: number) => void;
}) {
  if (lines.length === 0) return null;
  return (
    <div className="space-y-2">
      <p className="text-sm font-semibold text-brand-navy">Delivered</p>
      {lines.map((l) => {
        const value = counts[l.id] ?? l.open;
        return (
          <div key={l.id} className="flex items-center justify-between gap-3">
            <span className="text-sm text-brand-navy flex-1">{l.name}</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-label={`One fewer ${l.name}`}
                onClick={() => onChange(l.id, Math.max(0, value - 1))}
                className="w-11 h-11 rounded-lg border border-brand-gray/30 text-lg"
              >
                −
              </button>
              <span className="w-14 text-center text-base">
                {value} / {l.open}
              </span>
              <button
                type="button"
                aria-label={`One more ${l.name}`}
                onClick={() => onChange(l.id, Math.min(l.open, value + 1))}
                className="w-11 h-11 rounded-lg border border-brand-gray/30 text-lg"
              >
                +
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function CouldNotForm({
  pickup,
  busy,
  onSubmit,
  onCancel,
}: {
  pickup: boolean;
  busy: boolean;
  onSubmit: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <div className="space-y-3 border-t border-brand-gray/10 pt-4">
      <label className="block text-sm text-brand-gray" htmlFor="could-not-reason">
        Why couldn&apos;t it be {pickup ? "collected" : "delivered"}?
      </label>
      <textarea
        id="could-not-reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        maxLength={500}
        rows={2}
        className="w-full rounded-lg border border-brand-gray/30 p-2 text-base"
      />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 min-h-[60px] rounded-lg border border-brand-gray/30 text-base"
        >
          Back
        </button>
        <button
          type="button"
          disabled={busy || reason.trim() === ""}
          onClick={() => onSubmit(reason)}
          className="flex-1 min-h-[60px] rounded-lg bg-red-600 text-white font-semibold text-base disabled:opacity-50"
        >
          {busy ? "Saving..." : "Back to dispatch"}
        </button>
      </div>
    </div>
  );
}
