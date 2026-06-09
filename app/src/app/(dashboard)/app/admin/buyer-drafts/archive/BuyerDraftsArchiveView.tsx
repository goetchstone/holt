"use client";

// /app/src/app/(dashboard)/app/admin/buyer-drafts/archive/BuyerDraftsArchiveView.tsx
//
// Past Buys archive body. App Router port of the legacy admin/buyer-drafts/archive
// body (minus MainLayout chrome, which the (dashboard) layout supplies). Lists
// CLOSED buys grouped by year, each row linking to the per-Buy performance
// dashboard or back to the main page filtered to that Buy. Reads the shared
// /api/admin/buyer-drafts/buys/archive REST endpoint.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import axios from "axios";
import { toast } from "react-toastify";
import { Loader2, ArrowLeft, Archive, TrendingUp, ListChecks } from "lucide-react";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { getErrorMessage } from "@/lib/toastError";

interface ArchivedBuy {
  id: number;
  name: string;
  season: string | null;
  year: number | null;
  status: string;
  budget: string | null;
  kickoff: string | null;
  closedAt: string | null;
  spent: number;
  poCount: number;
  itemCount: number;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// Group buys by year (DESC), pinning undated buys last. Within a year the
// server order (closed-DESC) is preserved.
function groupByYear(buys: readonly ArchivedBuy[]): Array<[string, ArchivedBuy[]]> {
  const byYear = new Map<string, ArchivedBuy[]>();
  for (const b of buys) {
    const key = b.year !== null && b.year !== undefined ? String(b.year) : "Undated";
    const bucket = byYear.get(key);
    if (bucket) bucket.push(b);
    else byYear.set(key, [b]);
  }
  const yearKeys = [...byYear.keys()].sort((a, b) => {
    if (a === "Undated") return 1;
    if (b === "Undated") return -1;
    return Number(b) - Number(a);
  });
  return yearKeys.map((year) => [year, byYear.get(year) ?? []]);
}

export function BuyerDraftsArchiveView() {
  const [buys, setBuys] = useState<ArchivedBuy[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await axios.get<{ buys: ArchivedBuy[] }>("/api/admin/buyer-drafts/buys/archive");
      setBuys(res.data.buys ?? []);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to load archive"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="px-6 py-8 max-w-screen-xl mx-auto">
      <header className="mb-6">
        <Link
          href="/app/admin/buyer-drafts"
          className="text-sm text-sh-blue hover:underline inline-flex items-center gap-1"
        >
          <ArrowLeft className="h-3 w-3" /> Back to buyer drafts
        </Link>
        <div className="flex items-center gap-2 mt-2">
          <Archive className="h-6 w-6 text-sh-gray" />
          <h1 className="font-serif text-3xl text-sh-navy">Past Buys</h1>
        </div>
        <p className="text-sm text-sh-gray mt-2 max-w-2xl">
          Closed buys archive. Use this page to look back at completed buys, pull up the performance
          report for any of them, or drill into the items that landed in each. The main buyer-drafts
          page only shows active buys (planning, open, or in-flight) so you have a clean slate to
          plan against.
        </p>
      </header>

      <ArchiveBody loading={loading} buys={buys} />
    </div>
  );
}

function ArchiveBody({
  loading,
  buys,
}: Readonly<{ loading: boolean; buys: readonly ArchivedBuy[] }>) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-sh-gold" />
      </div>
    );
  }
  if (buys.length === 0) {
    return <EmptyState />;
  }
  return <ArchiveTable buys={buys} />;
}

function EmptyState() {
  return (
    <div className="bg-sh-stripe/30 border border-sh-stripe rounded-lg p-12 text-center">
      <Archive className="h-12 w-12 text-sh-gray mx-auto mb-3" />
      <h2 className="font-serif text-xl text-sh-navy mb-2">No closed buys yet</h2>
      <p className="text-sm text-sh-gray max-w-md mx-auto">
        Once a buy is finished, set its status to <code>CLOSED</code> from the edit modal and it
        will appear here for historical reporting.
      </p>
    </div>
  );
}

function ArchiveTable({ buys }: Readonly<{ buys: readonly ArchivedBuy[] }>) {
  const groups = groupByYear(buys);
  return (
    <div className="space-y-6">
      {groups.map(([year, yearBuys]) => (
        <section key={year} className="bg-white border border-sh-stripe rounded-lg overflow-hidden">
          <div className="px-4 py-2 bg-sh-stripe/50 border-b border-sh-stripe">
            <h2 className="font-serif text-lg text-sh-navy">
              {year}{" "}
              <span className="text-sm text-sh-gray font-sans">
                · {yearBuys.length} {yearBuys.length === 1 ? "buy" : "buys"}
              </span>
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-sh-gray tracking-wide">
                <tr className="border-b border-sh-stripe">
                  <th className="py-2 px-4">Buy</th>
                  <th className="py-2 px-4">Closed</th>
                  <th className="py-2 px-4 text-right">Budget</th>
                  <th className="py-2 px-4 text-right">Spent</th>
                  <th className="py-2 px-4 text-right">POs</th>
                  <th className="py-2 px-4 text-right">Items</th>
                  <th className="py-2 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {yearBuys.map((b) => (
                  <BuyRow key={b.id} buy={b} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}

function BuyRow({ buy }: Readonly<{ buy: ArchivedBuy }>) {
  const formatMoney = useMoneyFormatter();
  const budget = buy.budget ? Number(buy.budget) : null;
  const overBudget = budget !== null && buy.spent > budget;
  const overByTitle = overBudget
    ? `Over budget by ${formatMoney(buy.spent - (budget ?? 0), { whole: true })}`
    : undefined;
  return (
    <tr className="border-b border-sh-stripe/40 last:border-0 hover:bg-sh-stripe/20">
      <td className="py-3 px-4">
        <div className="font-semibold text-sh-navy">{buy.name}</div>
        {buy.season && <div className="text-xs text-sh-gray">{buy.season}</div>}
      </td>
      <td className="py-3 px-4 text-sh-gray text-xs">
        {buy.closedAt ? formatDate(buy.closedAt) : "—"}
      </td>
      <td className="py-3 px-4 text-right tabular-nums text-sh-gray">
        {budget === null ? "—" : formatMoney(budget, { whole: true })}
      </td>
      <td
        className={`py-3 px-4 text-right tabular-nums font-semibold ${
          overBudget ? "text-red-700" : "text-sh-navy"
        }`}
        title={overByTitle}
      >
        {formatMoney(buy.spent, { whole: true })}
      </td>
      <td className="py-3 px-4 text-right tabular-nums">{buy.poCount}</td>
      <td className="py-3 px-4 text-right tabular-nums">{buy.itemCount}</td>
      <td className="py-3 px-4">
        <div className="flex items-center justify-end gap-2">
          <Link
            href={`/app/admin/buyer-drafts/buy/${buy.id}/performance`}
            className="inline-flex items-center gap-1 text-xs text-sh-blue hover:underline min-h-[44px] px-2"
            title="View performance report"
          >
            <TrendingUp className="h-3.5 w-3.5" /> Performance
          </Link>
          <Link
            href={`/app/admin/buyer-drafts?buyId=${buy.id}`}
            className="inline-flex items-center gap-1 text-xs text-sh-blue hover:underline min-h-[44px] px-2"
            title="View items in this buy on the main page"
          >
            <ListChecks className="h-3.5 w-3.5" /> Items
          </Link>
        </div>
      </td>
    </tr>
  );
}
