"use client";

// /app/src/app/(dashboard)/app/reports/aged-stock/AgedStockView.tsx
//
// Aged Stock: how long uncommitted stock has been here, by department or vendor,
// with the oldest products listed (lib/reports/agedStock.ts). A point-in-time
// snapshot, so it runs by itself and refetches when the grouping changes. Cost
// only for a viewer holding "View cost": the response says which (costVisible),
// and the server left it out otherwise.

import { useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { CostHiddenNote } from "@/components/ui/CostHiddenNote";
import { api } from "@/lib/trpc/client";
import { AGE_BUCKETS } from "@/lib/reports/agedStockShared";
import type { InventoryPivot } from "@/lib/reports/inventoryHealth";

const qtyFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 });
const PIVOTS = ["department", "vendor"] as const satisfies readonly InventoryPivot[];
const LAST_BUCKET = AGE_BUCKETS.length - 1;

export function AgedStockView() {
  const money = useMoneyFormatter();
  const fmt = (v: number) => money(v, { whole: true });
  const [pivot, setPivot] = useState<InventoryPivot>("department");
  const query = api.reports.agedStock.useQuery({ pivot });
  const data = query.data;
  const costVisible = data?.costVisible === true;
  const totals = data?.totals;
  const uncosted = totals && "uncostedUnits" in totals ? totals.uncostedUnits : 0;
  const pivotLabel = pivot === "vendor" ? "Vendor" : "Department";

  /** What a bucket or a group is worth to this viewer: cost if they may see it. */
  const worth = (v: { costValue?: number; retailValue: number }) =>
    costVisible ? fmt(v.costValue ?? 0) : fmt(v.retailValue);

  return (
    <div className="space-y-6 font-serif">
      <nav className="text-sm text-brand-gray">
        <Link href="/app/reports" className="hover:underline">
          Reports
        </Link>
        <span className="mx-2">/</span>
        <span className="text-brand-black">Aged Stock</span>
      </nav>
      <h1 className="text-2xl font-semibold text-brand-navy">Aged Stock</h1>
      <p className="text-sm text-brand-gray">
        How long stock with no customer&apos;s name on it has been here, counted from when it came
        onto the books: received, returned, or found in a count. Moving it between places
        doesn&apos;t restart the clock. Assumes the oldest sells first, so what&apos;s left is the
        newest in. For stock that isn&apos;t selling, see{" "}
        <Link href="/app/reports/inventory-health" className="underline">
          Inventory Health
        </Link>
        .
      </p>

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

      {query.isLoading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-brand-gold" />
        </div>
      )}
      {query.error && <p className="text-sm text-red-700">{query.error.message}</p>}

      {totals && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {AGE_BUCKETS.map((bucket, i) => (
            <div
              key={bucket.label}
              className="rounded-lg border border-brand-gray/20 bg-white p-4 shadow-sm"
            >
              <div className="text-xs uppercase tracking-wide text-brand-gray">{bucket.label}</div>
              <div
                className={`mt-1 text-2xl font-semibold ${
                  i === LAST_BUCKET ? "text-red-700" : "text-brand-navy"
                }`}
              >
                {worth(totals.buckets[i])}
              </div>
              <div className="text-xs text-brand-gray">
                {qtyFmt.format(totals.buckets[i].units)} units
                {costVisible ? " at cost" : " at retail"}
              </div>
            </div>
          ))}
        </div>
      )}

      {data?.costVisible === false && <CostHiddenNote />}

      {data && totals && (
        <ul className="list-disc space-y-1 pl-5 text-xs text-brand-gray">
          {data.committedUnits > 0 && (
            <li>
              {qtyFmt.format(data.committedUnits)} more units are sold and waiting to leave, so they
              aren&apos;t counted here.
            </li>
          )}
          {totals.atLeastUnits > 0 && (
            <li>
              {qtyFmt.format(totals.atLeastUnits)} units are dated by an opening balance or an
              import, which only says when Holt first heard of them. They&apos;re at least this old.
            </li>
          )}
          {totals.noRecordUnits > 0 && (
            <li>
              {qtyFmt.format(totals.noRecordUnits)} units have no record of how they came in, so
              they aren&apos;t in any column above.
            </li>
          )}
          {uncosted > 0 && (
            <li>{qtyFmt.format(uncosted)} units have no cost, so they add nothing to the value.</li>
          )}
        </ul>
      )}

      {data && data.rows.length === 0 && (
        <p className="text-sm text-brand-gray">No uncommitted stock on the books.</p>
      )}

      {data && data.rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-brand-gray/20 bg-white shadow-md">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-brand-gray/20 bg-brand-linen">
                <th className="px-4 py-3 text-left font-semibold text-brand-gray">{pivotLabel}</th>
                <th className="px-4 py-3 text-right font-semibold text-brand-gray">Units</th>
                {AGE_BUCKETS.map((b) => (
                  <th
                    key={b.label}
                    className="whitespace-nowrap px-4 py-3 text-right font-semibold text-brand-gray"
                  >
                    {b.label}
                  </th>
                ))}
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
                    <div>{qtyFmt.format(row.units)}</div>
                    <div className="text-xs">{worth(row)}</div>
                  </td>
                  {row.buckets.map((b, j) => (
                    <td key={AGE_BUCKETS[j].label} className="px-4 py-3 text-right text-brand-gray">
                      <div>{qtyFmt.format(b.units)}</div>
                      <div className="text-xs">{worth(b)}</div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.oldest.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-brand-navy">Oldest products</h2>
          <p className="text-xs text-brand-gray">
            The {data.oldest.length} oldest of {qtyFmt.format(data.productCount)} products, by the
            oldest units still here.
          </p>
          <div className="overflow-x-auto rounded-lg border border-brand-gray/20 bg-white shadow-md">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-brand-gray/20 bg-brand-linen">
                  <th className="px-4 py-3 text-left font-semibold text-brand-gray">Product</th>
                  <th className="px-4 py-3 text-right font-semibold text-brand-gray">Units</th>
                  <th className="whitespace-nowrap px-4 py-3 text-left font-semibold text-brand-gray">
                    Here since
                  </th>
                  <th className="px-4 py-3 text-right font-semibold text-brand-gray">Days</th>
                  <th className="px-4 py-3 text-left font-semibold text-brand-gray">How</th>
                  <th className="px-4 py-3 text-right font-semibold text-brand-gray">Value</th>
                </tr>
              </thead>
              <tbody>
                {data.oldest.map((p, i) => (
                  <tr
                    key={p.productId}
                    className={`border-b border-brand-gray/10 ${i % 2 === 1 ? "bg-brand-stripe" : ""}`}
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/app/inventory/products/${p.productId}`}
                        className="font-semibold text-brand-navy hover:underline"
                      >
                        {p.name}
                      </Link>
                      <div className="text-xs text-brand-gray">{p.productNumber}</div>
                    </td>
                    <td className="px-4 py-3 text-right text-brand-gray">
                      {qtyFmt.format(p.units)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-brand-gray">
                      {p.atLeast ? "By " : ""}
                      {p.oldestOn}
                    </td>
                    <td className="px-4 py-3 text-right text-brand-gray">
                      {p.atLeast ? "At least " : ""}
                      {qtyFmt.format(p.oldestDays)}
                    </td>
                    <td className="px-4 py-3 text-brand-gray">{p.arrival}</td>
                    <td className="px-4 py-3 text-right text-brand-gray">{worth(p)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
