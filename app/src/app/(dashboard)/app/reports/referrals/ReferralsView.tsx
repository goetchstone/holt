"use client";

// /app/src/app/(dashboard)/app/reports/referrals/ReferralsView.tsx
//
// Referrals report body: by source, then the customers who sent the most.

import Link from "next/link";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import type { ReferralReport } from "@/lib/reports/referrals";

export function ReferralsView({ report }: Readonly<{ report: ReferralReport }>) {
  const money = useMoneyFormatter();
  const head = "p-2 border-b";
  return (
    <div className="py-2 space-y-6 font-serif">
      <div>
        <h1 className="text-2xl text-brand-blue font-semibold">Referrals</h1>
        <p className="text-sm text-brand-gray">
          How customers heard of you and who sent them, with what they have spent: sales less
          returns, leaving out cancelled lines. All time. Sources are set up in Settings › Referral
          sources; staff record them on each customer.
        </p>
      </div>

      <section>
        <h2 className="mb-2 text-lg text-brand-blue">By source</h2>
        {report.bySource.length === 0 ? (
          <p className="text-sm text-brand-gray">No referral sources yet.</p>
        ) : (
          <table className="w-full max-w-3xl text-left text-sm">
            <thead className="bg-brand-linen">
              <tr>
                <th className={head}>Source</th>
                <th className={`${head} text-right`}>Customers</th>
                <th className={`${head} text-right`}>Bought</th>
                <th className={`${head} text-right`}>Spent</th>
              </tr>
            </thead>
            <tbody>
              {report.bySource.map((r) => (
                <tr key={r.sourceId ?? "none"} className="odd:bg-white even:bg-brand-stripe">
                  <td className="p-2 border-b">
                    {r.name}
                    {!r.isActive && <span className="text-xs text-brand-gray"> (off)</span>}
                  </td>
                  <td className="p-2 border-b text-right">{r.customers}</td>
                  <td className="p-2 border-b text-right">{r.buyers}</td>
                  <td className="p-2 border-b text-right">{money(r.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-lg text-brand-blue">Who sent the most</h2>
        {report.referrers.length === 0 ? (
          <p className="text-sm text-brand-gray">
            No customer has been recorded as referring anyone.
          </p>
        ) : (
          <table className="w-full max-w-3xl text-left text-sm">
            <thead className="bg-brand-linen">
              <tr>
                <th className={head}>Customer</th>
                <th className={`${head} text-right`}>Sent</th>
                <th className={`${head} text-right`}>Bought</th>
                <th className={`${head} text-right`}>They spent</th>
              </tr>
            </thead>
            <tbody>
              {report.referrers.map((r) => (
                <tr key={r.referrerId} className="odd:bg-white even:bg-brand-stripe">
                  <td className="p-2 border-b">
                    <Link
                      href={`/app/sales/customers/${r.referrerId}`}
                      className="text-brand-blue underline"
                    >
                      {r.name}
                    </Link>
                  </td>
                  <td className="p-2 border-b text-right">{r.customers}</td>
                  <td className="p-2 border-b text-right">{r.buyers}</td>
                  <td className="p-2 border-b text-right">{money(r.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
