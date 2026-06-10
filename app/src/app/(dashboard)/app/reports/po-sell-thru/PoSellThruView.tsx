"use client";

// /app/src/app/(dashboard)/app/reports/po-sell-thru/PoSellThruView.tsx
//
// Client view for the PO Sell-Thru report. The manager types one or more PO
// numbers (comma-separated), runs the report, and gets a per-frame table:
// ordered vs received vs sold (stock + special split), sell-through %, margin,
// and realized retail (how close selling price came to full list). Same
// committed-filter tRPC pattern as Gross Margin. Each PO line's sell-through
// window starts at that line's receive date — frames with no receipts show no
// sales by design.

import { useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { api } from "@/lib/trpc/client";

const intFmt = new Intl.NumberFormat("en-US");

const STATUS_BADGES: Record<string, { label: string; className: string }> = {
  underbuy: { label: "Underbuy", className: "bg-amber-100 text-amber-800" },
  healthy: { label: "Healthy", className: "bg-green-100 text-green-800" },
  soft: { label: "Soft", className: "bg-sh-linen text-sh-gray" },
  dead: { label: "Dead", className: "bg-red-100 text-red-800" },
  pending: { label: "Pending", className: "bg-sh-stripe text-sh-gray" },
  "no-link": { label: "No link", className: "bg-sh-stripe text-sh-gray" },
};

function pct(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined) return "--";
  return `${(ratio * 100).toFixed(1)}%`;
}

function parsePoInput(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  );
}

export function PoSellThruView() {
  const money = useMoneyFormatter();
  const fmt = (v: number) => money(v, { whole: true });

  const [poInput, setPoInput] = useState("");
  const [committed, setCommitted] = useState<string[] | null>(null);

  const query = api.reports.poSellThru.useQuery(
    { poNumbers: committed ?? [] },
    { enabled: committed !== null && committed.length > 0 },
  );
  const loading = query.isFetching;
  const data = query.data;

  const run = () => {
    const parsed = parsePoInput(poInput);
    if (parsed.length > 0) setCommitted(parsed);
  };

  const anyEstimated = (data?.frames ?? []).some((f) => f.hasEstimatedCost);

  return (
    <div className="space-y-6 font-serif">
      <nav className="text-sm text-sh-gray">
        <Link href="/app/reports" className="hover:underline">
          Reports
        </Link>
        <span className="mx-2">/</span>
        <span className="text-sh-black">PO Sell-Thru</span>
      </nav>
      <h1 className="text-2xl font-semibold text-sh-navy">PO Sell-Thru</h1>
      <p className="text-sm text-sh-gray">
        How much of what these purchase orders delivered has sold. Each line&apos;s clock starts at
        its receive date and runs to today; variants of the same frame sold as special orders are
        counted separately. Consignment vendors are excluded.
      </p>

      <div className="flex flex-wrap items-end gap-4">
        <div className="min-w-[320px] flex-1">
          <label htmlFor="poNumbers" className="mb-1 block text-xs font-medium text-sh-gray">
            PO numbers (comma-separated)
          </label>
          <input
            id="poNumbers"
            type="text"
            value={poInput}
            onChange={(e) => setPoInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") run();
            }}
            placeholder="PO-1042, PO-1055"
            className="min-h-[44px] w-full rounded border border-gray-300 px-3 text-sm"
          />
        </div>
        <button
          type="button"
          onClick={run}
          disabled={loading || parsePoInput(poInput).length === 0}
          className="min-h-[44px] rounded-lg bg-sh-navy px-5 py-2 text-sm font-semibold text-white transition hover:bg-sh-blue disabled:opacity-50"
        >
          {loading ? "Loading..." : "Run Report"}
        </button>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-sh-gold" />
        </div>
      )}

      {data && !loading && data.notFound.length > 0 && (
        <p className="rounded border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          Not found (or consignment vendor): {data.notFound.join(", ")}
        </p>
      )}

      {data && !loading && data.pos.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {data.pos.map((po) => (
            <span
              key={po.poNumber}
              className="rounded-full border border-sh-gray/30 bg-white px-3 py-1 text-xs text-sh-black"
            >
              <span className="font-semibold text-sh-navy">{po.poNumber}</span> · {po.vendorName} ·{" "}
              {new Date(po.orderDate).toLocaleDateString("en-US", { timeZone: "UTC" })} ·{" "}
              {po.lineCount} line{po.lineCount === 1 ? "" : "s"} · {po.status}
            </span>
          ))}
        </div>
      )}

      {data && !loading && data.frames.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-sh-gray/20 bg-white shadow-md">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-sh-gray/20 bg-sh-linen">
                <th className="px-4 py-3 text-left font-semibold text-sh-gray">Frame</th>
                <th className="px-4 py-3 text-right font-semibold text-sh-gray">Ordered</th>
                <th className="px-4 py-3 text-right font-semibold text-sh-gray">Received</th>
                <th className="px-4 py-3 text-right font-semibold text-sh-gray">Stock Sold</th>
                <th className="px-4 py-3 text-right font-semibold text-sh-gray">Special Sold</th>
                <th className="px-4 py-3 text-right font-semibold text-sh-gray">Sell-Thru</th>
                <th className="px-4 py-3 text-right font-semibold text-sh-gray">Revenue</th>
                <th className="px-4 py-3 text-right font-semibold text-sh-gray">Margin</th>
                <th className="px-4 py-3 text-right font-semibold text-sh-gray">Realized Retail</th>
                <th className="px-4 py-3 text-left font-semibold text-sh-gray">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.frames.map((f, i) => {
                const badge = STATUS_BADGES[f.status] ?? STATUS_BADGES.pending;
                return (
                  <tr
                    key={f.frameKey}
                    className={`border-b border-sh-gray/10 ${i % 2 === 1 ? "bg-sh-stripe" : ""}`}
                  >
                    <td className="px-4 py-3 font-semibold text-sh-navy">{f.frameLabel}</td>
                    <td className="px-4 py-3 text-right">{intFmt.format(f.qtyOrdered)}</td>
                    <td className="px-4 py-3 text-right">{intFmt.format(f.qtyReceived)}</td>
                    <td className="px-4 py-3 text-right">{intFmt.format(f.qtyStockSold)}</td>
                    <td className="px-4 py-3 text-right text-sh-gray">
                      {intFmt.format(f.qtySpecialSold)}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold">
                      {pct(f.stockSellThroughRatio)}
                    </td>
                    <td className="px-4 py-3 text-right">{fmt(f.revenue)}</td>
                    <td className="px-4 py-3 text-right">
                      {pct(f.marginRatio)}
                      {f.hasEstimatedCost ? <span className="text-sh-gray"> (est)</span> : null}
                    </td>
                    <td className="px-4 py-3 text-right text-sh-gray">
                      {pct(f.realizedRetailRatio)}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-1 text-xs ${badge.className}`}>
                        {badge.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-sh-navy bg-sh-linen font-semibold text-sh-navy">
                <td className="px-4 py-3">Total</td>
                <td className="px-4 py-3 text-right">
                  {intFmt.format(data.rollup.totalQtyOrdered)}
                </td>
                <td className="px-4 py-3 text-right">
                  {intFmt.format(data.rollup.totalQtyReceived)}
                </td>
                <td className="px-4 py-3 text-right">
                  {intFmt.format(data.rollup.totalQtyStockSold)}
                </td>
                <td className="px-4 py-3 text-right">
                  {intFmt.format(data.rollup.totalQtySpecialSold)}
                </td>
                <td className="px-4 py-3 text-right">{pct(data.rollup.overallStockSellThrough)}</td>
                <td className="px-4 py-3 text-right">{fmt(data.rollup.totalRevenue)}</td>
                <td className="px-4 py-3 text-right">{pct(data.rollup.overallMargin)}</td>
                <td className="px-4 py-3 text-right">{pct(data.rollup.overallRealizedRetail)}</td>
                <td className="px-4 py-3" />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {data && !loading && anyEstimated && (
        <p className="text-xs text-sh-gray">
          Margins marked (est) include sold lines with no recorded cost — those fall back to an
          assumed 50% margin, so treat them as inferred, not measured.
        </p>
      )}

      {data && !loading && data.pos.length > 0 && data.frames.length === 0 && (
        <p className="py-8 text-center text-sh-gray">
          No receiving records on the selected POs yet — sell-through starts at receipt.
        </p>
      )}

      {committed === null && !loading && (
        <p className="py-16 text-center text-sh-gray">
          Enter one or more PO numbers and click Run Report
        </p>
      )}
    </div>
  );
}
