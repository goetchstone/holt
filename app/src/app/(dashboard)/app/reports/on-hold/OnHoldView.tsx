"use client";

// /app/src/app/(dashboard)/app/reports/on-hold/OnHoldView.tsx
//
// On hold report body: one row per held quote line, soonest to end first, with
// a link to its quote. CSV from /api/reports/on-hold.

import Link from "next/link";
import { format } from "date-fns";
import { parseLocalDate } from "@/lib/dateUtils";
import type { OnHoldRow } from "@/lib/reports/onHold";

function limitText(maxDays: number): string {
  if (maxDays === 0) return "This store's quotes hold nothing (Settings › Quote holds).";
  return `Quotes may hold stock for up to ${maxDays === 1 ? "1 day" : `${maxDays} days`}.`;
}

function endsText(daysLeft: number): string {
  if (daysLeft === 0) return "today";
  if (daysLeft === 1) return "tomorrow";
  return `in ${daysLeft} days`;
}

export function OnHoldView({ rows, maxDays }: Readonly<{ rows: OnHoldRow[]; maxDays: number }>) {
  return (
    <div className="py-2 space-y-4 font-serif">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl text-brand-blue font-semibold">On hold</h1>
        <button
          type="button"
          onClick={() => window.open("/api/reports/on-hold?format=csv", "_blank")}
          className="text-sm text-brand-blue underline"
        >
          Download CSV
        </button>
      </div>
      <p className="text-sm text-brand-gray">
        Floor stock quotes are holding for their customers, soonest to end first. Nobody else can
        sell it until the day after its hold ends, when it goes back on sale. {limitText(maxDays)}
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-brand-gray">Nothing is on hold.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-brand-linen text-brand-black">
              <tr>
                <th className="p-2 border-b whitespace-nowrap">Held until</th>
                <th className="p-2 border-b">Quote</th>
                <th className="p-2 border-b">Customer</th>
                <th className="p-2 border-b">Salesperson</th>
                <th className="p-2 border-b">Product</th>
                <th className="p-2 border-b text-right">Held</th>
                <th className="p-2 border-b">Where</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.lineItemId} className="odd:bg-white even:bg-brand-stripe align-top">
                  <td className="p-2 border-b whitespace-nowrap">
                    {format(parseLocalDate(r.holdUntil), "EEE MMM d")}
                    <span className="block text-xs text-brand-gray">
                      ends {endsText(r.daysLeft)}
                    </span>
                  </td>
                  <td className="p-2 border-b">
                    <Link
                      href={`/app/sales/orders/${r.salesOrderId}`}
                      className="text-brand-blue underline"
                    >
                      {r.orderno ?? `#${r.salesOrderId}`}
                    </Link>
                    {r.storeName && (
                      <span className="block text-xs text-brand-gray">{r.storeName}</span>
                    )}
                  </td>
                  <td className="p-2 border-b">{r.customerName ?? "—"}</td>
                  <td className="p-2 border-b">{r.salesperson ?? "—"}</td>
                  <td className="p-2 border-b">
                    {r.partNo || r.productName}
                    {r.partNo && r.productName && (
                      <span className="block text-xs text-brand-gray">{r.productName}</span>
                    )}
                  </td>
                  <td
                    className={`p-2 border-b text-right ${r.held < r.quantity ? "text-red-600" : ""}`}
                  >
                    {r.held} of {r.quantity}
                  </td>
                  <td className="p-2 border-b text-xs">{r.places.join("; ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
