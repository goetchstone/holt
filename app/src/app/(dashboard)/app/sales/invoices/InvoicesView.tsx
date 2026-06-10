"use client";

// /app/src/app/(dashboard)/app/sales/invoices/InvoicesView.tsx
//
// Invoice list: status filter chips + table + New Invoice. Data via
// billing.list (authored invoices only). Open balance shown for AR statuses.

import { useState } from "react";
import Link from "next/link";
import { Loader2, Plus } from "lucide-react";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { api } from "@/lib/trpc/client";

const STATUS_FILTERS = ["ALL", "DRAFT", "ISSUED", "PAID", "VOID"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

const STATUS_BADGE: Record<string, string> = {
  DRAFT: "bg-sh-stripe text-sh-gray",
  ISSUED: "bg-amber-100 text-amber-800",
  PAID: "bg-green-100 text-green-800",
  VOID: "bg-red-100 text-red-800",
};

export function InvoicesView() {
  const money = useMoneyFormatter();
  const [status, setStatus] = useState<StatusFilter>("ALL");

  const query = api.billing.list.useQuery(status === "ALL" ? {} : { status });
  const rows = query.data ?? [];

  return (
    <div className="space-y-6 font-serif">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-sh-navy">Invoices</h1>
          <p className="text-sm text-sh-gray">
            Bill a customer directly — draft, issue to the books, email with a pay link.
          </p>
        </div>
        <Link
          href="/app/sales/invoices/new"
          className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-sh-navy px-5 py-2 text-sm font-semibold text-white transition hover:bg-sh-blue"
        >
          <Plus className="h-4 w-4" /> New Invoice
        </Link>
      </div>

      <div className="inline-flex overflow-hidden rounded border border-gray-300">
        {STATUS_FILTERS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatus(s)}
            className={`min-h-[44px] px-4 text-sm capitalize transition ${
              status === s ? "bg-sh-navy text-white" : "bg-white text-sh-black hover:bg-sh-linen"
            }`}
          >
            {s.toLowerCase()}
          </button>
        ))}
      </div>

      {query.isLoading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-sh-gold" />
        </div>
      )}

      {!query.isLoading && rows.length === 0 && (
        <p className="py-12 text-center text-sh-gray">
          No invoices yet. Create one with New Invoice.
        </p>
      )}

      {rows.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-sh-gray/20 bg-white shadow-md">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-sh-gray/20 bg-sh-linen">
                <th className="px-4 py-3 text-left font-semibold text-sh-gray">Invoice</th>
                <th className="px-4 py-3 text-left font-semibold text-sh-gray">Customer</th>
                <th className="px-4 py-3 text-left font-semibold text-sh-gray">Date</th>
                <th className="px-4 py-3 text-left font-semibold text-sh-gray">Due</th>
                <th className="px-4 py-3 text-right font-semibold text-sh-gray">Total</th>
                <th className="px-4 py-3 text-right font-semibold text-sh-gray">Open</th>
                <th className="px-4 py-3 text-left font-semibold text-sh-gray">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={r.id}
                  className={`border-b border-sh-gray/10 ${i % 2 === 1 ? "bg-sh-stripe" : ""}`}
                >
                  <td className="px-4 py-3">
                    <Link
                      href={`/app/sales/invoices/${r.id}`}
                      className="font-semibold text-sh-navy hover:underline"
                    >
                      {r.invoiceNo}
                    </Link>
                  </td>
                  <td className="px-4 py-3">{r.customerName}</td>
                  <td className="px-4 py-3 text-sh-gray">
                    {new Date(r.invoiceDate).toLocaleDateString("en-US", { timeZone: "UTC" })}
                  </td>
                  <td className="px-4 py-3 text-sh-gray">
                    {r.dueDate
                      ? new Date(r.dueDate).toLocaleDateString("en-US", { timeZone: "UTC" })
                      : "--"}
                  </td>
                  <td className="px-4 py-3 text-right">{money(r.total)}</td>
                  <td className="px-4 py-3 text-right font-semibold">
                    {r.status === "ISSUED" ? money(r.openBalance) : "--"}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-1 text-xs ${STATUS_BADGE[r.status] ?? ""}`}
                    >
                      {r.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
