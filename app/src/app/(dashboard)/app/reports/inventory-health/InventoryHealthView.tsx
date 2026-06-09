"use client";

// /app/src/app/(dashboard)/app/reports/inventory-health/InventoryHealthView.tsx
//
// Client view for Inventory Health. Unlike the date-range reports this is a
// point-in-time snapshot, so it auto-runs and just refetches when the pivot or
// stale-window controls change (the query is a single GROUP BY — cheap). A KPI
// strip gives the at-a-glance numbers (inventory at cost, dead stock at cost, dead
// %); the table breaks it down by department or vendor. MANAGER/ADMIN; gated
// server-side. Dead = on-hand with no sale within the window (never-sold included).

import { useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { api } from "@/lib/trpc/client";

type Pivot = "department" | "vendor";

const intFmt = new Intl.NumberFormat("en-US");
const STALE_OPTIONS = [90, 180, 365] as const;

// Higher dead % is worse — color the risk.
function deadColor(pct: number | null): string {
  if (pct === null) return "text-sh-gray";
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

  const pivotLabel = pivot === "vendor" ? "Vendor" : "Department";
  const staleLabel = staleDays >= 365 ? "1 year" : `${staleDays} days`;
  const hasUncosted = (data?.totals.uncostedUnits ?? 0) > 0;

  return (
    <div className="space-y-6 font-serif">
      <nav className="text-sm text-sh-gray">
        <Link href="/app/reports" className="hover:underline">
          Reports
        </Link>
        <span className="mx-2">/</span>
        <span className="text-sh-black">Inventory Health</span>
      </nav>
      <h1 className="text-2xl font-semibold text-sh-navy">Inventory Health</h1>
      <p className="text-sm text-sh-gray">
        What&apos;s on hand right now, what it&apos;s worth, and how much isn&apos;t moving.
        &quot;Dead stock&quot; is on-hand inventory with no sale in {staleLabel} (never-sold
        included).
      </p>

      <div className="flex flex-wrap items-end gap-4">
        <div>
          <span className="mb-1 block text-xs font-medium text-sh-gray">Group by</span>
          <div className="inline-flex overflow-hidden rounded border border-gray-300">
            {(["department", "vendor"] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPivot(p)}
                className={`min-h-[44px] px-4 text-sm capitalize transition ${
                  pivot === p ? "bg-sh-navy text-white" : "bg-white text-sh-black hover:bg-sh-linen"
                }`}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
        <div>
          <span className="mb-1 block text-xs font-medium text-sh-gray">No-sale window</span>
          <div className="inline-flex overflow-hidden rounded border border-gray-300">
            {STALE_OPTIONS.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setStaleDays(d)}
                className={`min-h-[44px] px-4 text-sm transition ${
                  staleDays === d
                    ? "bg-sh-navy text-white"
                    : "bg-white text-sh-black hover:bg-sh-linen"
                }`}
              >
                {d >= 365 ? "1yr" : `${d}d`}
              </button>
            ))}
          </div>
        </div>
      </div>

      {data && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="rounded-lg border border-sh-gray/20 bg-white p-4 shadow-sm">
            <div className="text-xs uppercase tracking-wide text-sh-gray">Inventory at cost</div>
            <div className="mt-1 text-2xl font-semibold text-sh-navy">
              {fmt(data.totals.costValue)}
            </div>
            <div className="text-xs text-sh-gray">
              {intFmt.format(data.totals.units)} units · {fmt(data.totals.retailValue)} at retail
            </div>
          </div>
          <div className="rounded-lg border border-sh-gray/20 bg-white p-4 shadow-sm">
            <div className="text-xs uppercase tracking-wide text-sh-gray">
              Dead stock at cost ({staleLabel})
            </div>
            <div className="mt-1 text-2xl font-semibold text-red-700">
              {fmt(data.totals.deadCostValue)}
            </div>
            <div className="text-xs text-sh-gray">{intFmt.format(data.totals.deadUnits)} units</div>
          </div>
          <div className="rounded-lg border border-sh-gray/20 bg-white p-4 shadow-sm">
            <div className="text-xs uppercase tracking-wide text-sh-gray">Dead % of inventory</div>
            <div className={`mt-1 text-2xl font-semibold ${deadColor(data.totals.deadPct)}`}>
              {data.totals.deadPct === null ? "--" : `${data.totals.deadPct.toFixed(1)}%`}
            </div>
            <div className="text-xs text-sh-gray">by cost value</div>
          </div>
        </div>
      )}

      {loading && !data && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-sh-gold" />
        </div>
      )}

      {data && data.rows.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-sh-gray/20 bg-white shadow-md">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-sh-gray/20 bg-sh-linen">
                <th className="px-4 py-3 text-left font-semibold text-sh-gray">{pivotLabel}</th>
                <th className="px-4 py-3 text-right font-semibold text-sh-gray">On hand</th>
                <th className="px-4 py-3 text-right font-semibold text-sh-gray">Cost value</th>
                <th className="px-4 py-3 text-right font-semibold text-sh-gray">Retail value</th>
                <th className="px-4 py-3 text-right font-semibold text-sh-gray">Dead units</th>
                <th className="px-4 py-3 text-right font-semibold text-sh-gray">Dead $ (cost)</th>
                <th className="px-4 py-3 text-right font-semibold text-sh-gray">Dead %</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, i) => (
                <tr
                  key={row.key}
                  className={`border-b border-sh-gray/10 ${i % 2 === 1 ? "bg-sh-stripe" : ""}`}
                >
                  <td className="px-4 py-3 font-semibold text-sh-navy">{row.key}</td>
                  <td className="px-4 py-3 text-right text-sh-gray">{intFmt.format(row.units)}</td>
                  <td className="px-4 py-3 text-right font-semibold">{fmt(row.costValue)}</td>
                  <td className="px-4 py-3 text-right text-sh-gray">{fmt(row.retailValue)}</td>
                  <td className="px-4 py-3 text-right text-sh-gray">
                    {intFmt.format(row.deadUnits)}
                  </td>
                  <td className="px-4 py-3 text-right">{fmt(row.deadCostValue)}</td>
                  <td className={`px-4 py-3 text-right font-semibold ${deadColor(row.deadPct)}`}>
                    {row.deadPct === null ? "--" : `${row.deadPct.toFixed(1)}%`}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-sh-navy bg-sh-linen font-semibold text-sh-navy">
                <td className="px-4 py-3">Total</td>
                <td className="px-4 py-3 text-right">{intFmt.format(data.totals.units)}</td>
                <td className="px-4 py-3 text-right">{fmt(data.totals.costValue)}</td>
                <td className="px-4 py-3 text-right">{fmt(data.totals.retailValue)}</td>
                <td className="px-4 py-3 text-right">{intFmt.format(data.totals.deadUnits)}</td>
                <td className="px-4 py-3 text-right">{fmt(data.totals.deadCostValue)}</td>
                <td className={`px-4 py-3 text-right ${deadColor(data.totals.deadPct)}`}>
                  {data.totals.deadPct === null ? "--" : `${data.totals.deadPct.toFixed(1)}%`}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {data && hasUncosted && (
        <p className="text-xs text-sh-gray">
          {intFmt.format(data.totals.uncostedUnits)} on-hand units have no recorded cost, so cost
          value is understated where products are missing a cost in the catalog.
        </p>
      )}

      {data && data.rows.length === 0 && (
        <p className="py-8 text-center text-sh-gray">No on-hand inventory found.</p>
      )}
    </div>
  );
}
