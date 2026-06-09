// /app/src/app/(dashboard)/app/admin/buyer-drafts/BuysPanel.tsx
//
// Buys sidebar panel for the buyer-drafts workbench. Tabbed by status so the
// workspace stays clean:
//   Draft  → PLANNING            ("I'm still building this")
//   Open   → OPEN + EXPORTED     ("I'm working it / sent to the POS")
//   Closed → CLOSED              ("done — historical reference only")
// Default tab = Open. Each BuyCard is a drop target for a PO drag (buy-<id> →
// sets po.buyId); the UnassignedBuyDropZone (buy-unassigned) clears it.

"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Pencil, Archive } from "lucide-react";
import { useDroppable } from "@dnd-kit/core";
import { BUY_STATUS_BADGE, type DraftBuy, type IdOrAllOrUnassigned } from "./types";

type BuyTab = "DRAFT" | "OPEN" | "CLOSED";

const BUY_TAB_LABELS: Record<BuyTab, string> = {
  DRAFT: "Draft",
  OPEN: "Open",
  CLOSED: "Closed",
};

const EMPTY_TAB_COPY: Record<BuyTab, string> = {
  DRAFT: "No buys in planning. Click + New Buy to start one.",
  OPEN: "No open buys right now. Anything you flip to OPEN or EXPORTED will land here.",
  CLOSED: "No closed buys yet. Buys appear here after you mark them CLOSED.",
};

function tabForBuyStatus(status: DraftBuy["status"]): BuyTab {
  if (status === "PLANNING") return "DRAFT";
  if (status === "CLOSED") return "CLOSED";
  return "OPEN"; // OPEN + EXPORTED
}

interface BuysPanelProps {
  buys: readonly DraftBuy[];
  buyRollup: ReadonlyMap<number, number>;
  buyFilter: IdOrAllOrUnassigned;
  formatMoney: (value: number | null | undefined) => string;
  onSelect: (id: number) => void;
  onEdit: (b: DraftBuy) => void;
  onImportHistorical: (b: DraftBuy) => void;
}

export function BuysPanel({
  buys,
  buyRollup,
  buyFilter,
  formatMoney,
  onSelect,
  onEdit,
  onImportHistorical,
}: Readonly<BuysPanelProps>) {
  const [tab, setTab] = useState<BuyTab>("OPEN");

  const counts = useMemo(() => {
    const c: Record<BuyTab, number> = { DRAFT: 0, OPEN: 0, CLOSED: 0 };
    for (const b of buys) c[tabForBuyStatus(b.status)]++;
    return c;
  }, [buys]);

  // Sync the tab to the buy filter when it points at a specific buy (e.g.
  // ?buyId=N deep-link from the archive page) so the selected card is visible.
  useEffect(() => {
    if (typeof buyFilter !== "number") return;
    const selected = buys.find((b) => b.id === buyFilter);
    if (!selected) return;
    setTab(tabForBuyStatus(selected.status));
  }, [buyFilter, buys]);

  const bucketed = useMemo(
    () => buys.filter((b) => tabForBuyStatus(b.status) === tab),
    [buys, tab],
  );

  return (
    <div className="bg-white border border-sh-stripe rounded-lg p-4">
      <h2 className="font-serif text-lg text-sh-navy mb-3">Buys</h2>

      <div
        className="flex items-center gap-1 mb-3 border-b border-sh-stripe"
        role="tablist"
        aria-label="Buy status"
      >
        {(["DRAFT", "OPEN", "CLOSED"] as const).map((t) => {
          const active = tab === t;
          return (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t)}
              className={`px-3 py-2 text-xs font-semibold border-b-2 -mb-px min-h-[44px] ${
                active
                  ? "border-sh-navy text-sh-navy"
                  : "border-transparent text-sh-gray hover:text-sh-navy"
              }`}
            >
              {BUY_TAB_LABELS[t]}
              {counts[t] > 0 && (
                <span className="ml-1 text-sh-gray font-normal">({counts[t]})</span>
              )}
            </button>
          );
        })}
      </div>

      <BuysPanelBody
        tab={tab}
        bucketed={bucketed}
        buyRollup={buyRollup}
        buyFilter={buyFilter}
        formatMoney={formatMoney}
        onSelect={onSelect}
        onEdit={onEdit}
        onImportHistorical={onImportHistorical}
      />

      {/* Closed-tab footer — link to the richer archive table view. Hidden on
          Draft / Open tabs to keep the workspace focused. */}
      {tab === "CLOSED" && counts.CLOSED > 0 && (
        <div className="mt-3 pt-3 border-t border-sh-stripe">
          <Link
            href="/app/admin/buyer-drafts/archive"
            className="inline-flex items-center gap-1 text-xs text-sh-blue hover:underline"
          >
            <Archive className="h-3 w-3" /> Full archive report →
          </Link>
        </div>
      )}
    </div>
  );
}

interface BuysPanelBodyProps {
  tab: BuyTab;
  bucketed: readonly DraftBuy[];
  buyRollup: ReadonlyMap<number, number>;
  buyFilter: IdOrAllOrUnassigned;
  formatMoney: (value: number | null | undefined) => string;
  onSelect: (id: number) => void;
  onEdit: (b: DraftBuy) => void;
  onImportHistorical: (b: DraftBuy) => void;
}

function BuysPanelBody({
  tab,
  bucketed,
  buyRollup,
  buyFilter,
  formatMoney,
  onSelect,
  onEdit,
  onImportHistorical,
}: Readonly<BuysPanelBodyProps>) {
  if (bucketed.length === 0) {
    return <p className="text-sm text-sh-gray italic">{EMPTY_TAB_COPY[tab]}</p>;
  }
  return (
    <ul className="space-y-2">
      {/* You can't drop onto a closed buy, so the unassign target is Draft/Open only. */}
      {tab !== "CLOSED" && (
        <li>
          <UnassignedBuyDropZone />
        </li>
      )}
      {bucketed.map((b) => (
        <li key={b.id}>
          <BuyCard
            buy={b}
            spent={buyRollup.get(b.id) ?? 0}
            selected={buyFilter === b.id}
            formatMoney={formatMoney}
            onClick={() => onSelect(b.id)}
            onEdit={() => onEdit(b)}
            onImportHistorical={() => onImportHistorical(b)}
          />
        </li>
      ))}
    </ul>
  );
}

interface BuyCardProps {
  buy: DraftBuy;
  spent: number;
  selected: boolean;
  formatMoney: (value: number | null | undefined) => string;
  onClick: () => void;
  onEdit: () => void;
  onImportHistorical: () => void;
}

function buyCardStyle(isOver: boolean, selected: boolean): string {
  if (isOver) return "bg-sh-gold/30 border-2 border-sh-gold";
  if (selected) return "bg-sh-blue/10 border border-sh-blue";
  return "border border-sh-stripe hover:bg-sh-stripe/40";
}

function BuyCard({
  buy,
  spent,
  selected,
  formatMoney,
  onClick,
  onEdit,
  onImportHistorical,
}: Readonly<BuyCardProps>) {
  const budget = buy.budget ? Number(buy.budget) : null;
  const hasBudget = budget !== null;
  const overBudget = hasBudget && spent > budget;
  const ratio = hasBudget && budget > 0 ? Math.min(spent / budget, 1) : null;
  const seasonYear = [buy.season, buy.year].filter(Boolean).join(" ") || "—";

  // Droppable so a PO card can be dragged onto this Buy.
  const { isOver, setNodeRef } = useDroppable({ id: `buy-${buy.id}` });

  return (
    <div
      ref={setNodeRef}
      className={`w-full p-3 rounded text-sm transition-colors min-h-[44px] ${buyCardStyle(isOver, selected)}`}
    >
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          onClick={onClick}
          className="flex-1 text-left min-w-0"
          aria-label={`Filter to buy ${buy.name}`}
        >
          <div className="font-semibold text-sh-navy truncate" title={buy.name}>
            {buy.name}
          </div>
          <div className="text-xs text-sh-gray mt-0.5">{seasonYear}</div>
        </button>
        <div className="flex items-center gap-1 shrink-0">
          <span
            className={`font-mono px-2 py-0.5 rounded text-xs whitespace-nowrap ${BUY_STATUS_BADGE[buy.status]}`}
          >
            {buy.status}
          </span>
          <button
            type="button"
            onClick={onEdit}
            aria-label={`Edit buy ${buy.name}`}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center text-sh-gray hover:text-sh-navy hover:bg-sh-stripe rounded"
          >
            <Pencil className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Performance link (Slice 6) + Import historical PO (Slice 6.13) */}
      <div className="mt-2 flex items-center gap-3 text-xs">
        <a
          href={`/app/admin/buyer-drafts/buy/${buy.id}/performance`}
          onClick={(e) => e.stopPropagation()}
          className="text-sh-blue hover:underline"
        >
          View performance →
        </a>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onImportHistorical();
          }}
          className="text-sh-blue hover:underline"
        >
          Import historical PO
        </button>
      </div>

      <BuyBudgetBar
        hasBudget={hasBudget}
        budget={budget}
        spent={spent}
        ratio={ratio}
        overBudget={overBudget}
        formatMoney={formatMoney}
      />
    </div>
  );
}

interface BuyBudgetBarProps {
  hasBudget: boolean;
  budget: number | null;
  spent: number;
  ratio: number | null;
  overBudget: boolean;
  formatMoney: (value: number | null | undefined) => string;
}

function BuyBudgetBar({
  hasBudget,
  budget,
  spent,
  ratio,
  overBudget,
  formatMoney,
}: Readonly<BuyBudgetBarProps>) {
  if (!hasBudget) {
    return (
      <div className="text-xs text-sh-gray mt-2">{formatMoney(spent)} planned · no budget set</div>
    );
  }
  return (
    <div className="mt-2">
      <div className="flex justify-between text-xs">
        <span className="text-sh-gray">{formatMoney(spent)} spent</span>
        <span className={overBudget ? "text-red-700 font-semibold" : "text-sh-gray"}>
          {formatMoney(budget)} budget
        </span>
      </div>
      {ratio !== null && (
        <div className="h-1.5 w-full bg-sh-stripe rounded-full overflow-hidden mt-1">
          <div
            className={`h-full transition-all ${overBudget ? "bg-red-500" : "bg-sh-blue"}`}
            style={{ width: `${Math.round(ratio * 100)}%` }}
          />
        </div>
      )}
      {overBudget && budget !== null && (
        <div className="text-xs text-red-700 mt-1">Over by {formatMoney(spent - budget)}</div>
      )}
    </div>
  );
}

function UnassignedBuyDropZone() {
  const { isOver, setNodeRef } = useDroppable({ id: "buy-unassigned" });
  const style = isOver
    ? "border-2 border-dashed border-sh-gold bg-sh-gold/10"
    : "border-2 border-dashed border-sh-stripe";
  return (
    <div
      ref={setNodeRef}
      className={`p-3 rounded text-xs text-center text-sh-gray transition-colors ${style}`}
    >
      Drop a PO here to unassign it from its buy
    </div>
  );
}
