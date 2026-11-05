"use client";

// /app/src/app/(dashboard)/app/reports/inventory-value/InventoryValueView.tsx
//
// Inventory Value: what was on the books at the end of a past day, for one store
// or all of them (lib/reports/inventoryValue.ts). Quantities are the journal's;
// values are today's, because no history of cost is kept, and the screen says so
// beside the number. A date before the journal gets a notice instead of a zero.

import { useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { CostHiddenNote } from "@/components/ui/CostHiddenNote";
import { api } from "@/lib/trpc/client";
import type { InventoryPivot } from "@/lib/reports/inventoryHealth";

const qtyFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 });
const PIVOTS = ["department", "vendor"] as const satisfies readonly InventoryPivot[];

export function InventoryValueView({
  stores,
  today,
}: {
  readonly stores: readonly { id: number; name: string }[];
  /** The store's day: the latest date the report can be run for. */
  readonly today: string;
}) {
  const money = useMoneyFormatter();
  const fmt = (v: number) => money(v, { whole: true });
  const [asOf, setAsOf] = useState(today);
  const [pivot, setPivot] = useState<InventoryPivot>("department");
  const [storeId, setStoreId] = useState("");

  const query = api.reports.inventoryValue.useQuery(
    { asOf, pivot, storeLocationId: storeId ? Number(storeId) : null },
    { enabled: asOf !== "", retry: false },
  );
  const data = query.data;
  const costVisible = data?.costVisible === true;
  const totals = data?.totals;
  const costTotals = totals && "costValue" in totals ? totals : null;
  const pivotLabel = pivot === "vendor" ? "Vendor" : "Department";

  return (
    <div className="space-y-6 font-serif">
      <nav className="text-sm text-brand-gray">
        <Link href="/app/reports" className="hover:underline">
          Reports
        </Link>
        <span className="mx-2">/</span>
        <span className="text-brand-black">Inventory Value</span>
      </nav>
      <h1 className="text-2xl font-semibold text-brand-navy">Inventory Value</h1>
      <p className="text-sm text-brand-gray">
        What was on the books at the end of a day, committed or not, read back from every stock
        movement. <strong>Valued at today&apos;s cost and retail:</strong> Holt keeps no history of
        cost, so this shows how much stock you held in today&apos;s money, not what your books said
        it was worth that day.
      </p>

      <div className="flex flex-wrap items-end gap-4">
        <div>
          <label htmlFor="value-as-of" className="mb-1 block text-xs font-medium text-brand-gray">
            At the end of
          </label>
          <input
            id="value-as-of"
            type="date"
            value={asOf}
            max={today}
            onChange={(e) => setAsOf(e.target.value)}
            className="min-h-[44px] rounded border border-gray-300 px-3 text-sm"
          />
        </div>
        <div>
          <label htmlFor="value-store" className="mb-1 block text-xs font-medium text-brand-gray">
            Store
          </label>
          <select
            id="value-store"
            value={storeId}
            onChange={(e) => setStoreId(e.target.value)}
            className="min-h-[44px] rounded border border-gray-300 px-3 text-sm"
          >
            <option value="">All stores</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <span className="mb-1 block text-xs font-medium text-brand-gray">Group by</span>
          <div className="inline-flex overflow-hidden rounded border border-gray-300">
            {PIVOTS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPivot(p)}
                className={`min-h-[44px] px-4 text-sm capitalize transition ${
                  pivot === p
                    ? "bg-brand-navy text-white"
                    : "bg-white text-brand-black hover:bg-brand-linen"
                }`}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      </div>

      {query.isFetching && !data && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-brand-gold" />
        </div>
      )}
      {query.error && <p className="text-sm text-red-700">{query.error.message}</p>}

      {data?.beforeJournal && (
        <p className="rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          Holt&apos;s record of stock movements starts on {data.journalStartsOn}, so it can&apos;t
          say what was on hand on {data.asOf}. Choose that day or a later one.
        </p>
      )}

      {data && totals && !data.beforeJournal && (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {costTotals && (
              <div className="rounded-lg border border-brand-gray/20 bg-white p-4 shadow-sm">
                <div className="text-xs uppercase tracking-wide text-brand-gray">
                  At today&apos;s cost
                </div>
                <div className="mt-1 text-2xl font-semibold text-brand-navy">
                  {fmt(costTotals.costValue)}
                </div>
              </div>
            )}
            <div className="rounded-lg border border-brand-gray/20 bg-white p-4 shadow-sm">
              <div className="text-xs uppercase tracking-wide text-brand-gray">
                At today&apos;s retail
              </div>
              <div className="mt-1 text-2xl font-semibold text-brand-navy">
                {fmt(totals.retailValue)}
              </div>
            </div>
            <div className="rounded-lg border border-brand-gray/20 bg-white p-4 shadow-sm">
              <div className="text-xs uppercase tracking-wide text-brand-gray">On the books</div>
              <div className="mt-1 text-2xl font-semibold text-brand-navy">
                {qtyFmt.format(totals.units)} units
              </div>
            </div>
          </div>
          {data.costVisible === false && <CostHiddenNote />}
          {costTotals && costTotals.uncostedUnits > 0 && (
            <p className="text-xs text-brand-gray">
              {qtyFmt.format(costTotals.uncostedUnits)} units have no cost, so they add nothing to
              the cost value.
            </p>
          )}
          {data.journalStartsOn && (
            <p className="text-xs text-brand-gray">
              The record of stock movements starts on {data.journalStartsOn}. A movement counts from
              the day it was entered in Holt.
            </p>
          )}

          {data.rows.length === 0 ? (
            <p className="text-sm text-brand-gray">Nothing was on the books.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-brand-gray/20 bg-white shadow-md">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-brand-gray/20 bg-brand-linen">
                    <th className="px-4 py-3 text-left font-semibold text-brand-gray">
                      {pivotLabel}
                    </th>
                    <th className="px-4 py-3 text-right font-semibold text-brand-gray">Units</th>
                    {costVisible && (
                      <th className="px-4 py-3 text-right font-semibold text-brand-gray">
                        Today&apos;s cost
                      </th>
                    )}
                    <th className="px-4 py-3 text-right font-semibold text-brand-gray">
                      Today&apos;s retail
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row, i) => (
                    <tr
                      key={row.key}
                      className={`border-b border-brand-gray/10 ${i % 2 === 1 ? "bg-brand-stripe" : ""}`}
                    >
                      <td className="px-4 py-3 font-semibold text-brand-navy">{row.key}</td>
                      <td className="px-4 py-3 text-right text-brand-gray">
                        {qtyFmt.format(row.units)}
                      </td>
                      {"costValue" in row && (
                        <td className="px-4 py-3 text-right font-semibold">{fmt(row.costValue)}</td>
                      )}
                      <td className="px-4 py-3 text-right text-brand-gray">
                        {fmt(row.retailValue)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
