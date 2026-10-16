"use client";

// /app/src/app/(dashboard)/app/reports/oversold/OversoldView.tsx
//
// Oversold report body: one row per product short, the orders waiting on it,
// and a suggested fix. Store filter in memory; CSV from /api/reports/oversold.

import { useMemo, useState } from "react";

type Fix =
  | { kind: "FREE_HERE"; storeName: string; quantity: number }
  | { kind: "FREE_ELSEWHERE"; storeName: string; quantity: number }
  | { kind: "ON_PO"; poNumber: string; quantity: number; due: string | null }
  | { kind: "ORDER_IT" };

interface Row {
  productId: number;
  productName: string;
  partNo: string | null;
  shortfall: number;
  orders: {
    orderno: string;
    salesOrderId: number;
    storeName: string;
    shortfall: number;
    since: string;
  }[];
  fix: Fix;
}

function fixText(fix: Fix): string {
  if (fix.kind === "FREE_HERE") {
    return `${fix.quantity} free at ${fix.storeName}: commit it (re-save the order)`;
  }
  if (fix.kind === "FREE_ELSEWHERE") return `${fix.quantity} free at ${fix.storeName}: transfer it`;
  if (fix.kind === "ON_PO") {
    return `${fix.quantity} on ${fix.poNumber}${fix.due ? `, due ${fix.due.slice(0, 10)}` : ""}`;
  }
  return "Nothing on order: start a draft PO";
}

export function OversoldView({ rows }: { rows: Row[] }) {
  const [store, setStore] = useState("");
  const stores = useMemo(
    () => Array.from(new Set(rows.flatMap((r) => r.orders.map((o) => o.storeName)))).sort(),
    [rows],
  );
  const shown = useMemo(
    () =>
      store
        ? rows
            .map((r) => ({ ...r, orders: r.orders.filter((o) => o.storeName === store) }))
            .filter((r) => r.orders.length > 0)
        : rows,
    [rows, store],
  );

  return (
    <div className="py-2 space-y-4 font-serif">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl text-brand-blue font-semibold">Oversold</h1>
        <a href="/api/reports/oversold?format=csv" className="text-sm text-brand-blue underline">
          Download CSV
        </a>
      </div>
      <p className="text-sm text-brand-gray">
        Sales that went through with less free stock than they needed. A row closes itself once the
        order holds what it needs.
      </p>
      <div className="flex items-center gap-3">
        <label htmlFor="oversold-store" className="text-sm text-brand-gray">
          Store:
        </label>
        <select
          id="oversold-store"
          value={store}
          onChange={(e) => setStore(e.target.value)}
          className="border border-brand-gray/30 rounded px-2 py-1 text-sm"
        >
          <option value="">All stores</option>
          {stores.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      {shown.length === 0 && <p className="text-sm text-brand-gray">Nothing oversold.</p>}
      {shown.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-brand-gray border-b border-brand-gray/20">
                <th className="py-2 pr-3">Product</th>
                <th className="py-2 pr-3">Short</th>
                <th className="py-2 pr-3">Orders waiting</th>
                <th className="py-2">Suggested fix</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.productId} className="border-b border-brand-gray/10 align-top">
                  <td className="py-2 pr-3">
                    {r.productName}
                    <div className="text-xs text-brand-gray">{r.partNo}</div>
                  </td>
                  <td className="py-2 pr-3">{r.orders.reduce((s, o) => s + o.shortfall, 0)}</td>
                  <td className="py-2 pr-3">
                    {r.orders.map((o) => (
                      <div key={`${o.salesOrderId}`}>
                        <a href={`/app/sales/orders/${o.salesOrderId}`} className="text-brand-blue">
                          {o.orderno}
                        </a>{" "}
                        <span className="text-xs text-brand-gray">
                          {o.storeName} · {o.shortfall} short since {o.since.slice(0, 10)}
                        </span>
                      </div>
                    ))}
                  </td>
                  <td className="py-2">{fixText(r.fix)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
