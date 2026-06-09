"use client";

// /app/src/app/(dashboard)/app/reports/commission/CommissionView.tsx
//
// Team commission — view-only LOCKED payouts by designer + pay period. SUPER_ADMIN
// (tabled per owner direction 2026-05-29). Data via tRPC; the page gated
// server-side.

import { useMemo } from "react";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { api } from "@/lib/trpc/client";

const utcDate = (d: Date | string) =>
  new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

function PaidCell({ paidOn }: Readonly<{ paidOn: Date | string | null }>) {
  if (paidOn) return <span className="text-green-700">{utcDate(paidOn)}</span>;
  return <span className="text-sh-gray">—</span>;
}

export function CommissionView() {
  const money = useMoneyFormatter();
  const currency = (v: number) => money(v, { whole: true });

  const query = api.reports.commissionPayouts.useQuery({});
  const rows = useMemo(() => query.data?.payouts ?? [], [query.data]);
  const loading = query.isFetching && !query.data;
  const total = useMemo(() => rows.reduce((s, r) => s + r.commissionAmount, 0), [rows]);

  return (
    <div className="mx-auto mt-8 max-w-5xl space-y-6 font-serif">
      <div>
        <h1 className="text-2xl font-semibold text-sh-blue">Team Commission</h1>
        <p className="mt-1 text-sm text-sh-gray">
          Locked commission payouts by designer and pay period. View only — the commission plan and
          payout locking are managed separately.
        </p>
      </div>

      {loading && <p className="text-sh-gray">Loading…</p>}
      {!loading && rows.length === 0 && (
        <p className="p-4 text-center text-sh-gray">No locked commission payouts yet.</p>
      )}
      {!loading && rows.length > 0 && (
        <div className="overflow-x-auto rounded border border-sh-stripe bg-white">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-sh-linen text-sh-black">
              <tr>
                <th className="p-2 font-medium">Designer</th>
                <th className="p-2 font-medium">Pay Period</th>
                <th className="p-2 text-right font-medium">Period Sales</th>
                <th className="p-2 text-right font-medium">Commission</th>
                <th className="p-2 font-medium">Paid</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={r.id}
                  className={`border-t border-sh-stripe ${i % 2 === 1 ? "bg-sh-stripe/40" : ""}`}
                >
                  <td className="p-2">{r.staffMemberName}</td>
                  <td className="whitespace-nowrap p-2">
                    {utcDate(r.periodStart)} – {utcDate(r.periodEnd)}
                  </td>
                  <td className="p-2 text-right tabular-nums">{currency(r.periodSalesAmount)}</td>
                  <td className="p-2 text-right font-semibold tabular-nums text-sh-navy">
                    {currency(r.commissionAmount)}
                  </td>
                  <td className="p-2">
                    <PaidCell paidOn={r.paidOn} />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-sh-navy bg-sh-linen">
                <td className="p-2 font-semibold text-sh-navy" colSpan={3}>
                  Total commission
                </td>
                <td className="p-2 text-right font-semibold tabular-nums text-sh-navy">
                  {currency(total)}
                </td>
                <td className="p-2" />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
