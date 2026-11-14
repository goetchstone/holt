"use client";

// /app/src/app/(dashboard)/app/inventory/products/[id]/PriceHistorySection.tsx
//
// A product's price lock and its price history (GAP-06, DECISIONS 58). A locked
// price is kept by imports, mass price changes and vendor style edits; someone
// editing this product can still change it. The history is its price ledger
// (ProductPriceChange), newest first: every change to its retail or was price,
// from what to what, by whom and through what. Locking needs "Change pricing";
// the route says so if it's refused (rule 11).

import { useState } from "react";
import axios from "axios";
import { format } from "date-fns";
import { toast } from "react-toastify";
import { Lock, LockOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { getErrorMessage } from "@/lib/toastError";
import { PRICE_CHANGE_SOURCES, isPriceChangeSource } from "@/lib/pricing/priceChangeSources";

export interface PriceHistoryEntry {
  id: number;
  fromRetail: number | null;
  toRetail: number | null;
  fromWas: number | null;
  toWas: number | null;
  source: string;
  batchId: string | null;
  note: string | null;
  actor: string;
  createdAt: string;
}

/** How many entries the route sends (its PRICE_HISTORY_SHOWN). */
const SHOWN = 50;

function sourceLabel(source: string): string {
  return isPriceChangeSource(source) ? PRICE_CHANGE_SOURCES[source] : source;
}

function sameCents(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.round(a * 100) === Math.round(b * 100);
}

function Move({
  from,
  to,
  fmt,
}: Readonly<{
  from: number | null;
  to: number | null;
  fmt: (value: number | null | undefined) => string;
}>) {
  if (sameCents(from, to)) return <span className="text-brand-gray">—</span>;
  const show = (v: number | null) => (v === null ? "none" : fmt(v));
  return (
    <span className="tabular-nums">
      {show(from)} → <strong>{show(to)}</strong>
    </span>
  );
}

export function PriceHistorySection({
  productId,
  priceLocked,
  history,
  canChangePricing,
  onChanged,
}: Readonly<{
  productId: number;
  priceLocked: boolean;
  history: PriceHistoryEntry[];
  canChangePricing: boolean;
  onChanged: () => void;
}>) {
  const fmt = useMoneyFormatter();
  const [busy, setBusy] = useState(false);

  const toggleLock = async () => {
    setBusy(true);
    try {
      await axios.patch(`/api/products/${productId}`, { priceLocked: !priceLocked });
      toast.success(priceLocked ? "Price unlocked." : "Price locked.");
      onChanged();
    } catch (err) {
      toast.error(getErrorMessage(err, "The price lock wasn't changed."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-white p-6 rounded-lg shadow-md mb-6 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold flex items-center gap-2">
            Price history
            {priceLocked && (
              <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-2 py-0.5 text-xs font-normal text-amber-900">
                <Lock className="h-3 w-3" aria-hidden /> Price locked
              </span>
            )}
          </h2>
          <p className="mt-1 text-xs text-brand-gray">
            {priceLocked
              ? "Imports, mass price changes and vendor style edits keep this price as it is. A change made here, by hand, still applies."
              : "Imports, mass price changes and vendor style edits may change this price. Lock it to keep it as it is."}
          </p>
        </div>
        {canChangePricing && (
          <Button variant="outline" onClick={toggleLock} disabled={busy}>
            {priceLocked ? (
              <>
                <LockOpen className="mr-2 h-4 w-4" aria-hidden /> Unlock price
              </>
            ) : (
              <>
                <Lock className="mr-2 h-4 w-4" aria-hidden /> Lock price
              </>
            )}
          </Button>
        )}
      </div>

      {history.length === 0 ? (
        <p className="text-sm text-brand-gray">No price changes recorded yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-brand-gray/20 text-left text-xs uppercase tracking-wide text-brand-gray">
                <th className="px-2 py-2">When</th>
                <th className="px-2 py-2">Retail</th>
                <th className="px-2 py-2">Was price</th>
                <th className="px-2 py-2">Through</th>
                <th className="px-2 py-2">By</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id} className="border-b border-brand-gray/10 align-top">
                  <td className="px-2 py-2 whitespace-nowrap">
                    {format(new Date(h.createdAt), "PP p")}
                  </td>
                  <td className="px-2 py-2">
                    <Move from={h.fromRetail} to={h.toRetail} fmt={fmt} />
                  </td>
                  <td className="px-2 py-2">
                    <Move from={h.fromWas} to={h.toWas} fmt={fmt} />
                  </td>
                  <td className="px-2 py-2">
                    {sourceLabel(h.source)}
                    {h.note && <span className="block text-xs text-brand-gray">{h.note}</span>}
                  </td>
                  <td className="px-2 py-2 break-all">{h.actor}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {history.length >= SHOWN && (
            <p className="mt-2 text-xs text-brand-gray">
              The latest {SHOWN} changes. Older ones are kept, not shown.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
