"use client";

// /app/src/app/(dashboard)/app/inventory/sales/SalesView.tsx
//
// Inventory > Sales (GAP-06 part B, DECISIONS 60). Lists every scheduled sale by
// where it stands on the store's day (on now, upcoming, ended), opens one to
// change or end it, starts a new one, and shows the tags that change today.
// The server decides "today" and every price; this screen only shows them.

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import Link from "next/link";
import { toast } from "react-toastify";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/components/branding/BrandingProvider";
import { getErrorMessage } from "@/lib/toastError";
import { saleDayText, salesInListOrder, type SaleSummary } from "@/lib/pricing/salesShared";
import { SaleEditor, SaleStatusChip } from "./SaleEditor";
import { TagsToChangePanel } from "./TagsToChangePanel";

type Mode = { kind: "list" } | { kind: "new" } | { kind: "sale"; id: number };

function SalesTable({
  sales,
  locale,
  onOpen,
}: Readonly<{ sales: SaleSummary[]; locale: string; onOpen: (id: number) => void }>) {
  if (sales.length === 0) {
    return (
      <p className="bg-white border border-brand-gray/20 rounded-lg px-4 py-8 text-center text-sm text-brand-gray">
        No sales yet. Start one with New sale.
      </p>
    );
  }
  return (
    <div className="bg-white border border-brand-gray/20 rounded-lg overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-brand-gray/20 text-left text-xs text-brand-gray uppercase tracking-wide">
            <th className="px-3 py-2">Sale</th>
            <th className="px-3 py-2">Runs</th>
            <th className="px-3 py-2">Where it stands</th>
            <th className="px-3 py-2 text-right">Products</th>
          </tr>
        </thead>
        <tbody>
          {sales.map((s) => (
            <tr
              key={s.id}
              onClick={() => onOpen(s.id)}
              className="border-b border-brand-gray/10 cursor-pointer hover:bg-brand-stripe"
            >
              <td className="px-3 py-2">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpen(s.id);
                  }}
                  className="text-brand-blue hover:underline text-left"
                >
                  {s.name}
                </button>
                {s.note && <p className="text-xs text-brand-gray">{s.note}</p>}
              </td>
              <td className="px-3 py-2 whitespace-nowrap">
                {saleDayText(s.startsOn, locale)} – {saleDayText(s.endsOn, locale)}
              </td>
              <td className="px-3 py-2">
                <SaleStatusChip status={s.status} endedEarly={s.endedEarlyAt !== null} />
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{s.itemCount.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SalesView() {
  const { locale } = useLocale();
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [data, setData] = useState<{ today: string; sales: SaleSummary[] } | null>(null);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    axios
      .get<{ today: string; sales: SaleSummary[] }>("/api/pricing/sales")
      .then((res) => {
        if (live) setData(res.data);
      })
      .catch((err) => {
        if (live) toast.error(getErrorMessage(err, "Couldn't load the sales."));
      });
    return () => {
      live = false;
    };
  }, [tick]);

  const backToList = useCallback(() => {
    setMode({ kind: "list" });
    reload();
  }, [reload]);

  return (
    <div className="py-2 space-y-6 font-serif">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/app/inventory" className="text-brand-blue hover:underline text-sm">
          Inventory
        </Link>
        <span className="text-brand-gray">/</span>
        {mode.kind === "list" ? (
          <h1 className="text-2xl font-semibold text-brand-blue">Sales</h1>
        ) : (
          <button onClick={backToList} className="text-brand-blue hover:underline text-sm">
            Sales
          </button>
        )}
        {mode.kind === "list" && (
          <Button onClick={() => setMode({ kind: "new" })} className="ml-auto min-h-[40px]">
            <Plus className="mr-2 h-4 w-4" aria-hidden /> New sale
          </Button>
        )}
      </div>

      {mode.kind === "list" && (
        <>
          <p className="text-sm text-brand-gray">
            A sale gives its products a sale price from its first day to its last, both included, on
            the store&apos;s days
            {data ? ` (today is ${saleDayText(data.today, locale)})` : ""}. The register, quotes and
            tags use the sale price while it is on; nothing else about the product changes. Change a
            sale&apos;s dates or products only before it starts; once it has started it can only be
            ended early.
          </p>
          <TagsToChangePanel />
          {data ? (
            <SalesTable
              sales={salesInListOrder(data.sales)}
              locale={locale}
              onOpen={(id) => setMode({ kind: "sale", id })}
            />
          ) : (
            <p className="text-sm text-brand-gray">Loading…</p>
          )}
        </>
      )}

      {mode.kind !== "list" && data && (
        <SaleEditor
          key={mode.kind === "sale" ? mode.id : "new"}
          saleId={mode.kind === "sale" ? mode.id : null}
          today={data.today}
          onSaved={(id) => {
            setMode({ kind: "sale", id });
            reload();
          }}
          onGone={backToList}
        />
      )}
    </div>
  );
}
