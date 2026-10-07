"use client";

// /app/src/app/(dashboard)/app/reports/inventory-health/InventoryHealthView.tsx
//
// Client view for Inventory Health. Unlike the date-range reports this is a
// point-in-time snapshot, so it auto-runs and just refetches when the pivot or
// stale-window controls change (the query is a single GROUP BY — cheap). A KPI
// strip gives the at-a-glance numbers (inventory at cost, dead stock at cost, dead
// %); the table breaks it down by department or vendor. MANAGER/ADMIN; gated
// server-side. Dead = on-hand with no sale within the window (never-sold included).
// Cost value, dead-stock cost, dead % and uncosted units only for a viewer holding
// "View cost": the response says which (costVisible), and the server left them
// out (and ordered rows by retail value) otherwise. That viewer gets units on
// hand, retail value and dead units.

import { useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { api } from "@/lib/trpc/client";
import { CostHiddenNote } from "@/components/ui/CostHiddenNote";
import type { InventoryHealthRow } from "@/lib/reports/inventoryHealth";

type CostField = "costValue" | "deadCostValue" | "deadPct" | "uncostedUnits";
type Row = Omit<InventoryHealthRow, CostField> & Partial<Pick<InventoryHealthRow, CostField>>;

type Pivot = "department" | "vendor";

const intFmt = new Intl.NumberFormat("en-US");
const STALE_OPTIONS = [90, 180, 365] as const;

// Higher dead % is worse — color the risk.
function deadColor(pct: number | null): string {
  if (pct === null) return "text-brand-gray";
  if (pct >= 40) return "text-red-700";
  if (pct >= 20) return "text-amber-600";
  return "text-green-700";
}

export function InventoryHealthView() {
  const money = useMoneyFormatter();
  const fmt = (v: number) => money(v, { whole: true });

  const [pivot, setPivot] = useState<Pivot>("department");
  const [staleDays, setStaleDays] = useState<number>(180);

  const query = api.reports.inventoryHealth.useQuery({ pivot, staleDays });
  const loading = query.isFetching;
  const data = query.data;
  const costVisible = data?.costVisible === true;
  // The holder's totals; null before the first answer and for a viewer without
  // "View cost", whose totals carry no cost keys.
  const costTotals = data && costVisible && "costValue" in data.totals ? data.totals : null;

  const pivotLabel = pivot === "vendor" ? "Vendor" : "Department";
  const staleLabel = staleDays >= 365 ? "1 year" : `${staleDays} days`;
  const hasUncosted = (costTotals?.uncostedUnits ?? 0) > 0;

  return (
    <div className="space-y-6 font-serif">
      <nav className="text-sm text-brand-gray">
        <Link href="/app/reports" className="hover:underline">
          Reports
        </Link>
        <span className="mx-2">/</span>
        <span className="text-brand-black">Inventory Health</span>
      </nav>
      <h1 className="text-2xl font-semibold text-brand-navy">Inventory Health</h1>
      <p className="text-sm text-brand-gray">
        What&apos;s on hand right now, what it&apos;s worth, and how much isn&apos;t moving.
        &quot;Dead stock&quot; is on-hand inventory with no sale in {staleLabel} (never-sold
        included).
      </p>

      <div className="flex flex-wrap items-end gap-4">
        <div>
          <span className="mb-1 block text-xs font-medium text-brand-gray">Group by</span>
          <div className="inline-flex overflow-hidden rounded border border-gray-300">
            {(["department", "vendor"] as const).map((p) => (
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
        <div>
          <span className="mb-1 block text-xs font-medium text-brand-gray">No-sale window</span>
          <div className="inline-flex overflow-hidden rounded border border-gray-300">
            {STALE_OPTIONS.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setStaleDays(d)}
                className={`min-h-[44px] px-4 text-sm transition ${
                  staleDays === d
                    ? "bg-brand-navy text-white"
                    : "bg-white text-brand-black hover:bg-brand-linen"
                }`}
              >
                {d >= 365 ? "1yr" : `${d}d`}
              </button>
            ))}
          </div>
        </div>
      </div>

      {costTotals && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="rounded-lg border border-brand-gray/20 bg-white p-4 shadow-sm">
            <div className="text-xs uppercase tracking-wide text-brand-gray">Inventory at cost</div>
            <div className="mt-1 text-2xl font-semibold text-brand-navy">
              {fmt(costTotals.costValue)}
            </div>
            <div className="text-xs text-brand-gray">
              {intFmt.format(costTotals.units)} units · {fmt(costTotals.retailValue)} at retail
            </div>
          </div>
          <div className="rounded-lg border border-brand-gray/20 bg-white p-4 shadow-sm">
            <div className="text-xs uppercase tracking-wide text-brand-gray">
              Dead stock at cost ({staleLabel})
            </div>
            <div className="mt-1 text-2xl font-semibold text-red-700">
              {fmt(costTotals.deadCostValue)}
            </div>
            <div className="text-xs text-brand-gray">
              {intFmt.format(costTotals.deadUnits)} units
            </div>
          </div>
          <div className="rounded-lg border border-brand-gray/20 bg-white p-4 shadow-sm">
            <div className="text-xs uppercase tracking-wide text-brand-gray">
              Dead % of inventory
            </div>
            <div className={`mt-1 text-2xl font-semibold ${deadColor(costTotals.deadPct)}`}>
              {costTotals.deadPct === null ? "--" : `${costTotals.deadPct.toFixed(1)}%`}
            </div>
            <div className="text-xs text-brand-gray">by cost value</div>
          </div>
        </div>
      )}

      {data && !costTotals && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="rounded-lg border border-brand-gray/20 bg-white p-4 shadow-sm">
            <div className="text-xs uppercase tracking-wide text-brand-gray">On hand</div>
            <div className="mt-1 text-2xl font-semibold text-brand-navy">
              {intFmt.format(data.totals.units)} units
            </div>
            <div className="text-xs text-brand-gray">{fmt(data.totals.retailValue)} at retail</div>
          </div>
          <div className="rounded-lg border border-brand-gray/20 bg-white p-4 shadow-sm">
            <div className="text-xs uppercase tracking-wide text-brand-gray">
              Dead stock ({staleLabel})
            </div>
            <div className="mt-1 text-2xl font-semibold text-red-700">
              {intFmt.format(data.totals.deadUnits)} units
            </div>
          </div>
        </div>
      )}

      {data?.costVisible === false && <CostHiddenNote />}

      {loading && !data && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-brand-gold" />
        </div>
      )}

      {data && data.rows.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-brand-gray/20 bg-white shadow-md">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-brand-gray/20 bg-brand-linen">
                <th className="px-4 py-3 text-left font-semibold text-brand-gray">{pivotLabel}</th>
                <th className="px-4 py-3 text-right font-semibold text-brand-gray">On hand</th>
                {costVisible && (
                  <th className="px-4 py-3 text-right font-semibold text-brand-gray">Cost value</th>
                )}
                <th className="px-4 py-3 text-right font-semibold text-brand-gray">Retail value</th>
                <th className="px-4 py-3 text-right font-semibold text-brand-gray">Dead units</th>
                {costVisible && (
                  <>
                    <th className="px-4 py-3 text-right font-semibold text-brand-gray">
                      Dead $ (cost)
                    </th>
                    <th className="px-4 py-3 text-right font-semibold text-brand-gray">Dead %</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row: Row, i) => (
                <tr
                  key={row.key}
                  className={`border-b border-brand-gray/10 ${i % 2 === 1 ? "bg-brand-stripe" : ""}`}
                >
                  <td className="px-4 py-3 font-semibold text-brand-navy">{row.key}</td>
                  <td className="px-4 py-3 text-right text-brand-gray">
                    {intFmt.format(row.units)}
                  </td>
                  {costVisible && (
                    <td className="px-4 py-3 text-right font-semibold">
                      {fmt(row.costValue ?? 0)}
                    </td>
                  )}
                  <td className="px-4 py-3 text-right text-brand-gray">{fmt(row.retailValue)}</td>
                  <td className="px-4 py-3 text-right text-brand-gray">
                    {intFmt.format(row.deadUnits)}
                  </td>
                  {costVisible && (
                    <>
                      <td className="px-4 py-3 text-right">{fmt(row.deadCostValue ?? 0)}</td>
                      <td
                        className={`px-4 py-3 text-right font-semibold ${deadColor(row.deadPct ?? null)}`}
                      >
                        {row.deadPct == null ? "--" : `${row.deadPct.toFixed(1)}%`}
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-brand-navy bg-brand-linen font-semibold text-brand-navy">
                <td className="px-4 py-3">Total</td>
                <td className="px-4 py-3 text-right">{intFmt.format(data.totals.units)}</td>
                {costTotals && (
                  <td className="px-4 py-3 text-right">{fmt(costTotals.costValue)}</td>
                )}
                <td className="px-4 py-3 text-right">{fmt(data.totals.retailValue)}</td>
                <td className="px-4 py-3 text-right">{intFmt.format(data.totals.deadUnits)}</td>
                {costTotals && (
                  <>
                    <td className="px-4 py-3 text-right">{fmt(costTotals.deadCostValue)}</td>
                    <td className={`px-4 py-3 text-right ${deadColor(costTotals.deadPct)}`}>
                      {costTotals.deadPct === null ? "--" : `${costTotals.deadPct.toFixed(1)}%`}
                    </td>
                  </>
                )}
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {costTotals && hasUncosted && (
        <p className="text-xs text-brand-gray">
          {intFmt.format(costTotals.uncostedUnits)} on-hand units have no recorded cost, so cost
          value is understated where products are missing a cost in the catalog.
        </p>
      )}

      {data && data.rows.length === 0 && (
        <p className="py-8 text-center text-brand-gray">No on-hand inventory found.</p>
      )}
    </div>
  );
}
