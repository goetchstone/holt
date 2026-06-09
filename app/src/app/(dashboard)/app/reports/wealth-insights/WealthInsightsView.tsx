"use client";

// /app/src/app/(dashboard)/app/reports/wealth-insights/WealthInsightsView.tsx
//
// Windfall wealth-insights report. Clickable tier/signal/level/group filters all
// feed the tRPC query input directly (react-query refetches on key change).
// ADMIN/MARKETING; the page gated server-side.

import { useState } from "react";
import Link from "next/link";
import { KpiCard } from "@/components/report";
import { WealthTierBadge } from "@/components/customer/WealthTierBadge";
import { Button } from "@/components/ui/button";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { api } from "@/lib/trpc/client";
import type { CustomerRow } from "@/lib/reports/wealthInsights";

const TIER_LABELS: Record<string, string> = {
  ULTRA_HIGH: "$10M+",
  VERY_HIGH: "$5-10M",
  HIGH: "$1-5M",
  AFFLUENT: "$500K-1M",
};

function formatNetWorth(nw: number): string {
  if (nw >= 1_000_000) return `$${(nw / 1_000_000).toFixed(1)}M`;
  if (nw >= 1_000) return `$${Math.round(nw / 1_000)}K`;
  return `$${nw}`;
}

const SIGNAL_FIELDS: Record<string, string> = {
  recentMover: "Recent Mover",
  boatOwner: "Boat Owner",
  planeOwner: "Plane Owner",
  multiPropertyOwner: "Multi-property",
  rentalPropertyOwner: "Rental Property",
  philanthropicGiver: "Philanthropic Giver",
  smallBusinessOwner: "Small Business",
  politicalDonor: "Political Donor",
  moneyInMotion: "Money in Motion",
  recentMortgage: "Recent Mortgage",
  trustAssociation: "Trust Association",
};

const SIGNAL_LABEL_TO_FIELD = Object.fromEntries(
  Object.entries(SIGNAL_FIELDS).map(([k, v]) => [v, k]),
);

const LEVEL_LABELS: Record<number, string> = {
  1: "Occasional",
  2: "Frequent",
  3: "High Value",
  4: "VIP",
};

const LEVEL_COLORS: Record<number, string> = {
  1: "bg-sh-gray/20 text-sh-gray",
  2: "bg-sh-brand-blue/20 text-sh-brand-blue",
  3: "bg-sh-gold/20 text-sh-gold",
  4: "bg-green-100 text-green-800",
};

const LEVEL_FILTER_MAP: Record<string, string> = {
  VIP: "4",
  "High Value": "3",
  Frequent: "2",
  Occasional: "1",
  Dormant: "DORMANT",
};

const GROUP_OPTIONS: { id: string; label: string }[] = [
  { id: "FURNITURE", label: "Furniture" },
  { id: "HOME_ACC", label: "Home Accessories" },
  { id: "APPAREL", label: "Apparel" },
  { id: "CHRISTMAS", label: "Christmas" },
];

function CustomerLevelCell({ row }: Readonly<{ row: CustomerRow }>) {
  if (!row.customerLevel && row.peakCustomerLevel && LEVEL_LABELS[row.peakCustomerLevel]) {
    return (
      <span className="inline-block rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
        Dormant
      </span>
    );
  }
  if (!row.customerLevel) return <span className="text-xs text-sh-gray">—</span>;
  const color = LEVEL_COLORS[row.customerLevel] || "bg-sh-gray/20 text-sh-gray";
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${color}`}>
      {LEVEL_LABELS[row.customerLevel] || "—"}
    </span>
  );
}

function exportCsv(rows: CustomerRow[], filename: string) {
  const headers = [
    "Name",
    "Email",
    "Phone",
    "City",
    "Net Worth",
    "Tier",
    "Level",
    "Orders",
    "Total Spend",
  ];
  const csvRows = rows.map((r) => [
    [r.firstName, r.lastName].filter(Boolean).join(" "),
    r.email || "",
    r.phone || "",
    r.city || "",
    r.netWorth ?? "",
    r.wealthTier || "",
    r.customerLevel ? LEVEL_LABELS[r.customerLevel] || "" : r.peakCustomerLevel ? "Dormant" : "",
    r.orderCount,
    r.totalSpend,
  ]);
  const csv = [headers, ...csvRows].map((r) => r.map((v) => `"${v}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function WealthInsightsView() {
  const money = useMoneyFormatter();
  const currency = (n: number) => money(n, { whole: true });

  const [activeSignal, setActiveSignal] = useState<string | null>(null);
  const [activeTier, setActiveTier] = useState<string | null>(null);
  const [activeLevel, setActiveLevel] = useState<string | null>(null);
  const [activeGroups, setActiveGroups] = useState<string[]>([]);

  const query = api.reports.wealthInsights.useQuery({
    signal: activeSignal,
    tier: activeTier,
    level: activeLevel,
    groups: activeGroups,
  });
  const data = query.data;
  const loading = query.isFetching && !data;

  const handleSignalClick = (label: string) => {
    const field = SIGNAL_LABEL_TO_FIELD[label];
    if (!field) return;
    setActiveSignal((cur) => (cur === field ? null : field));
  };
  const handleTierClick = (tier: string) => setActiveTier((cur) => (cur === tier ? null : tier));
  const handleLevelClick = (level: string) => {
    const filterValue = LEVEL_FILTER_MAP[level];
    if (!filterValue) return;
    setActiveLevel((cur) => (cur === filterValue ? null : filterValue));
  };
  const handleGroupClick = (id: string) =>
    setActiveGroups((cur) => (cur.includes(id) ? cur.filter((g) => g !== id) : [...cur, id]));

  const hasAnyFilter = Boolean(
    activeSignal || activeTier || activeLevel || activeGroups.length > 0,
  );

  const clearFilter = () => {
    setActiveSignal(null);
    setActiveTier(null);
    setActiveLevel(null);
    setActiveGroups([]);
  };

  return (
    <div className="space-y-6 py-2 font-serif">
      <div className="flex items-center gap-3">
        <Link href="/app/reports" className="text-sm text-sh-blue hover:underline">
          Reports
        </Link>
        <span className="text-sh-gray">/</span>
        <h1 className="text-2xl font-semibold text-sh-blue">Wealth Insights</h1>
      </div>

      {loading || !data ? (
        <p className="py-16 text-center text-sh-gray">Loading...</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <KpiCard label="Windfall Matched" value={data.totals.matched} />
            <KpiCard label="With Net Worth" value={data.totals.withNetWorth} />
            <KpiCard label="Avg Net Worth" value={formatNetWorth(data.totals.avgNetWorth)} />
            <KpiCard label="Recent Movers" value={data.recentMovers.length} />
          </div>

          <div className="rounded-xl border border-sh-gray/15 bg-white p-5">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-sh-navy">
              Wealth Tiers
            </h2>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              {data.tiers.map((t) => (
                <button
                  key={t.tier}
                  type="button"
                  onClick={() => handleTierClick(t.tier)}
                  className={`cursor-pointer rounded-lg bg-sh-linen p-4 text-center transition ${activeTier === t.tier ? "ring-2 ring-sh-blue" : "hover:ring-1 hover:ring-sh-gray/30"}`}
                >
                  <WealthTierBadge tier={t.tier} />
                  <p className="mt-2 text-2xl font-semibold text-sh-black">
                    {t.count.toLocaleString()}
                  </p>
                  <p className="mt-1 text-xs text-sh-gray">{TIER_LABELS[t.tier] || t.tier}</p>
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-sh-gray/15 bg-white p-5">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-sh-navy">
              Lifestyle Signals
            </h2>
            <div className="flex flex-wrap gap-3">
              {data.signals.map((s) => {
                const field = SIGNAL_LABEL_TO_FIELD[s.signal];
                return (
                  <button
                    key={s.signal}
                    type="button"
                    onClick={() => handleSignalClick(s.signal)}
                    className={`cursor-pointer rounded-lg bg-sh-linen px-4 py-3 text-center transition ${activeSignal === field ? "ring-2 ring-sh-blue" : "hover:ring-1 hover:ring-sh-gray/30"}`}
                  >
                    <p className="text-lg font-semibold text-sh-black">
                      {s.count.toLocaleString()}
                    </p>
                    <p className="mt-0.5 text-xs text-sh-gray">{s.signal}</p>
                  </button>
                );
              })}
            </div>
          </div>

          {data.levels.length > 0 && (
            <div className="rounded-xl border border-sh-gray/15 bg-white p-5">
              <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-sh-navy">
                Customer Levels
              </h2>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
                {data.levels.map((l) => {
                  const filterValue = LEVEL_FILTER_MAP[l.level];
                  return (
                    <button
                      key={l.level}
                      type="button"
                      onClick={() => handleLevelClick(l.level)}
                      className={`cursor-pointer rounded-lg bg-sh-linen p-4 text-center transition ${activeLevel === filterValue ? "ring-2 ring-sh-blue" : "hover:ring-1 hover:ring-sh-gray/30"}`}
                    >
                      <CustomerLevelCell
                        row={
                          {
                            customerLevel:
                              l.level === "Dormant" ? null : Number.parseInt(filterValue, 10),
                            peakCustomerLevel: l.level === "Dormant" ? 4 : null,
                          } as CustomerRow
                        }
                      />
                      <p className="mt-2 text-2xl font-semibold text-sh-black">
                        {l.count.toLocaleString()}
                      </p>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="rounded-xl border border-sh-gray/15 bg-white p-5">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-sh-navy">
              Primary Customer Group
            </h2>
            <div className="flex flex-wrap gap-2">
              {GROUP_OPTIONS.map((opt) => {
                const active = activeGroups.includes(opt.id);
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => handleGroupClick(opt.id)}
                    className={`min-h-[32px] rounded-full border px-3 py-1.5 text-xs transition-colors ${
                      active
                        ? "border-sh-blue bg-sh-blue text-white"
                        : "border-sh-gray/30 text-sh-gray hover:border-sh-blue"
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {data.filteredCustomers && data.filteredCustomers.length > 0 && (
            <div className="rounded-xl border border-sh-blue/30 bg-white p-5 ring-2 ring-sh-blue/10">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-widest text-sh-navy">
                  {[
                    activeTier ? TIER_LABELS[activeTier] || activeTier : null,
                    activeLevel
                      ? activeLevel === "DORMANT"
                        ? "Dormant"
                        : LEVEL_LABELS[Number.parseInt(activeLevel, 10)] || activeLevel
                      : null,
                    activeSignal ? SIGNAL_FIELDS[activeSignal] : null,
                  ]
                    .filter(Boolean)
                    .join(" + ") || "Filtered"}{" "}
                  — {data.filteredCustomers.length} customers
                </h2>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      exportCsv(
                        data.filteredCustomers ?? [],
                        `windfall_${activeSignal || activeTier || "filtered"}.csv`,
                      )
                    }
                  >
                    Export CSV
                  </Button>
                  <Button variant="outline" size="sm" onClick={clearFilter}>
                    Clear Filter
                  </Button>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-sh-gray/20">
                      <th className="px-3 py-2 text-left font-semibold text-sh-gray">Customer</th>
                      <th className="px-3 py-2 text-left font-semibold text-sh-gray">Email</th>
                      <th className="px-3 py-2 text-left font-semibold text-sh-gray">Phone</th>
                      <th className="px-3 py-2 text-left font-semibold text-sh-gray">City</th>
                      <th className="px-3 py-2 text-right font-semibold text-sh-gray">Net Worth</th>
                      <th className="px-3 py-2 text-left font-semibold text-sh-gray">Tier</th>
                      <th className="px-3 py-2 text-left font-semibold text-sh-gray">Level</th>
                      <th className="px-3 py-2 text-right font-semibold text-sh-gray">Orders</th>
                      <th className="px-3 py-2 text-right font-semibold text-sh-gray">Spend</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.filteredCustomers.slice(0, 200).map((c) => (
                      <tr key={c.id} className="border-b border-sh-gray/10">
                        <td className="px-3 py-2">
                          <Link
                            href={`/app/sales/customers/${c.id}`}
                            className="text-sh-blue hover:underline"
                          >
                            {[c.firstName, c.lastName].filter(Boolean).join(" ") || "Unknown"}
                          </Link>
                        </td>
                        <td className="px-3 py-2 text-xs text-sh-gray">{c.email || "—"}</td>
                        <td className="px-3 py-2 text-xs text-sh-gray">{c.phone || "—"}</td>
                        <td className="px-3 py-2 text-xs text-sh-gray">{c.city || "—"}</td>
                        <td className="px-3 py-2 text-right">
                          {c.netWorth ? formatNetWorth(c.netWorth) : "—"}
                        </td>
                        <td className="px-3 py-2">
                          <WealthTierBadge tier={c.wealthTier} />
                        </td>
                        <td className="px-3 py-2">
                          <CustomerLevelCell row={c} />
                        </td>
                        <td className="px-3 py-2 text-right">{c.orderCount}</td>
                        <td className="px-3 py-2 text-right">
                          {c.totalSpend > 0 ? currency(c.totalSpend) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {data.filteredCustomers.length > 200 && (
                <p className="mt-3 text-center text-xs text-sh-gray">
                  Showing first 200 of {data.filteredCustomers.length}. Export CSV for full list.
                </p>
              )}
            </div>
          )}

          {data.recentMovers.length > 0 && !hasAnyFilter && (
            <div className="rounded-xl border border-sh-gray/15 bg-white p-5">
              <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-sh-navy">
                Recent Movers — Warm Leads
              </h2>
              <p className="mb-3 text-xs text-sh-gray">
                Customers who recently moved. New homes need furniture.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-sh-gray/20">
                      <th className="px-3 py-2 text-left font-semibold text-sh-gray">Customer</th>
                      <th className="px-3 py-2 text-left font-semibold text-sh-gray">Email</th>
                      <th className="px-3 py-2 text-right font-semibold text-sh-gray">Net Worth</th>
                      <th className="px-3 py-2 text-left font-semibold text-sh-gray">Tier</th>
                      <th className="px-3 py-2 text-left font-semibold text-sh-gray">Level</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentMovers.map((c) => (
                      <tr key={c.id} className="border-b border-sh-gray/10">
                        <td className="px-3 py-2">
                          <Link
                            href={`/app/sales/customers/${c.id}`}
                            className="text-sh-blue hover:underline"
                          >
                            {[c.firstName, c.lastName].filter(Boolean).join(" ") || "Unknown"}
                          </Link>
                        </td>
                        <td className="px-3 py-2 text-xs text-sh-gray">{c.email || "—"}</td>
                        <td className="px-3 py-2 text-right">
                          {c.netWorth ? formatNetWorth(c.netWorth) : "—"}
                        </td>
                        <td className="px-3 py-2">
                          <WealthTierBadge tier={c.wealthTier} />
                        </td>
                        <td className="px-3 py-2">
                          <CustomerLevelCell row={c} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {!hasAnyFilter && (
            <div className="rounded-xl border border-sh-gray/15 bg-white p-5">
              <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-sh-navy">
                Top 50 Customers by Net Worth
              </h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-sh-gray/20">
                      <th className="px-3 py-2 text-left font-semibold text-sh-gray">Customer</th>
                      <th className="px-3 py-2 text-right font-semibold text-sh-gray">Net Worth</th>
                      <th className="px-3 py-2 text-left font-semibold text-sh-gray">Tier</th>
                      <th className="px-3 py-2 text-left font-semibold text-sh-gray">Level</th>
                      <th className="px-3 py-2 text-right font-semibold text-sh-gray">Orders</th>
                      <th className="px-3 py-2 text-right font-semibold text-sh-gray">
                        Total Spend
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topCustomers.map((c) => (
                      <tr key={c.id} className="border-b border-sh-gray/10">
                        <td className="px-3 py-2">
                          <Link
                            href={`/app/sales/customers/${c.id}`}
                            className="text-sh-blue hover:underline"
                          >
                            {[c.firstName, c.lastName].filter(Boolean).join(" ") || "Unknown"}
                          </Link>
                        </td>
                        <td className="px-3 py-2 text-right">
                          {c.netWorth ? formatNetWorth(c.netWorth) : "—"}
                        </td>
                        <td className="px-3 py-2">
                          <WealthTierBadge tier={c.wealthTier} />
                        </td>
                        <td className="px-3 py-2">
                          <CustomerLevelCell row={c} />
                        </td>
                        <td className="px-3 py-2 text-right">{c.orderCount}</td>
                        <td className="px-3 py-2 text-right">
                          {c.totalSpend > 0 ? currency(c.totalSpend) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
