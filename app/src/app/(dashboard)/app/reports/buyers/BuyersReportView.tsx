"use client";

// /app/src/app/(dashboard)/app/reports/buyers/BuyersReportView.tsx
//
// Buyers Report — App Router + tRPC client view. On-hand + on-order + sold in a
// user-picked date range, pivoted by department or vendor. MANAGER/ADMIN (gated
// server-side).
//
// Drills 5 levels deep:
//   department pivot: Department -> Category -> Type -> Vendor -> Part #
//   vendor pivot:     Vendor -> Department -> Category -> Type -> Part #
//
// UX ported verbatim from the Pages version:
//   - summary auto-runs on filter change (tRPC useQuery keyed by the filters);
//     the "Run" button force-refetches
//   - click a row to drill in; breadcrumb stepping takes you back up
//   - KPI cards + Attention Panel re-scope to wherever you're drilled
//   - leaf rows expand inline to a per-location breakdown, fetched on demand
//     and cached (tRPC utils.fetch)
//   - saved-view chips, department hint banner, season-range apply
//   - CSV export stays a client-side blob (the legacy page had no REST export
//     route)
//
// The on-hand / classification / weeks-supply / sell-through math is all in
// src/lib/reports/buyersReport.ts + src/lib/buyersRollup.ts — unchanged.

import { Fragment, useEffect, useState, useMemo } from "react";
import Link from "next/link";
import { toast } from "react-toastify";
import {
  ChevronRight,
  Download,
  AlertTriangle,
  Archive,
  Eye,
  MapPin,
  ExternalLink,
} from "lucide-react";
import { endOfDay, format, startOfDay, subDays } from "date-fns";
import { KpiCard, ReportSection } from "@/components/report";
import { Button } from "@/components/ui/button";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { getErrorMessage } from "@/lib/toastError";
import { api } from "@/lib/trpc/client";
import type { BuyersNode, BuyersPivot } from "@/lib/buyersRollup";
import type { PositionsResponse } from "@/lib/reports/buyersReport";

type SavedView = "all" | "top-sellers" | "dead-stock" | "running-low" | "new-not-moving";

const SAVED_VIEWS: { id: SavedView; label: string; hint: string }[] = [
  { id: "all", label: "All", hint: "Every row." },
  { id: "top-sellers", label: "Top sellers", hint: "Sorted by revenue, hides zero-sold rows." },
  { id: "dead-stock", label: "Dead stock", hint: "On hand > 0 with zero sold in range." },
  { id: "running-low", label: "Running low", hint: "Weeks of supply below 2 and still selling." },
  {
    id: "new-not-moving",
    label: "New, not moving",
    hint: "Zero-sold rows that hold inventory or open POs.",
  },
];

const num = (v: number) => v.toLocaleString("en-US");

const formatDate = (iso: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

// Column label for the first column changes based on how deep we've drilled.
function depthLabel(pivot: BuyersPivot, depth: number): string {
  const deptPath = ["Department", "Category", "Type", "Vendor", "Part #"];
  const vendorPath = ["Vendor", "Department", "Category", "Type", "Part #"];
  return (pivot === "department" ? deptPath : vendorPath)[Math.min(depth, 4)];
}

// Margin KPI label: "—" when nothing sold, else "NN.N%" with a trailing "*"
// when any contributing line used the retail/2 cost estimate.
function formatScopeMargin(avgMarginPct: number | null, costEstimated: boolean): string {
  if (avgMarginPct === null) return "—";
  const star = costEstimated ? "*" : "";
  return `${avgMarginPct.toFixed(1)}%${star}`;
}

// Result-section heading. At the root it's the count of pivot roots; once
// drilled it's the count of children under the current crumb.
function sectionTitle(pivot: BuyersPivot, effectiveCrumbs: string[], rowCount: number): string {
  if (effectiveCrumbs.length === 0) {
    return `${rowCount} ${pivot === "department" ? "departments" : "vendors"}`;
  }
  const label = depthLabel(pivot, effectiveCrumbs.length).toLowerCase();
  const plural = rowCount === 1 ? "" : "s";
  const crumb = effectiveCrumbs[effectiveCrumbs.length - 1];
  return `${rowCount} ${label}${plural} under ${crumb}`;
}

// Department hint banner data. Keyed by the first crumb (which is the
// drilled department when pivot=department, or the department at depth 1
// on the vendor pivot — though vendor pivot is less canonical). All
// seasonality windows are data-backed (CLAUDE.md rule 41):
//   - Christmas: Oct 1 - Jan 31 (Oct ramps at ~13% of peak, Nov+Dec = 80-85%
//     of annual, Jan clearance = ~10% of Dec). September not material.
//   - Outdoor:   Apr 1 - Aug 31 (June peaks at 15% of annual, May-Aug =
//     51% of annual. Nov-Dec combined only 9% - does not ride holiday).
//   - Apparel:   no auto-range (3 peaks: Dec 16%, May 11%, Aug 10%). On
//     Order not trustworthy - PO receipts not tracked per workflow.
//   - Rugs:      consignment; point to Rugs Buying Guide (Ship 3) for
//     size/quality buyer view.
interface DeptHint {
  kind: "season" | "apparel" | "rugs";
  title: string;
  message: string;
  seasonStart?: string; // YYYY-MM-DD of current or last completed season
  seasonEnd?: string;
}

function lastCompletedSeasonStart(monthIndex: number, today: Date): string {
  // Return the most-recently-started Oct 1 / Apr 1 for the season that
  // would cover today or has just completed. monthIndex: 9 = Oct, 3 = Apr.
  const y = today.getFullYear();
  const seasonStartThisYear = new Date(y, monthIndex, 1);
  if (today >= seasonStartThisYear) return formatISODate(seasonStartThisYear);
  return formatISODate(new Date(y - 1, monthIndex, 1));
}

function formatISODate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function getDeptHint(crumbLabels: string[], pivot: BuyersPivot, today: Date): DeptHint | null {
  if (pivot !== "department" || crumbLabels.length === 0) return null;
  const dept = crumbLabels[0].toLowerCase();
  if (dept.includes("christmas") || dept.includes("holiday")) {
    const start = lastCompletedSeasonStart(9, today); // October
    const endYear = new Date(start).getFullYear() + 1;
    return {
      kind: "season",
      title: "Christmas season",
      message:
        "Data shows the active season is October 1 to January 31 (Nov+Dec = 80–85% of annual; September is not meaningful).",
      seasonStart: start,
      seasonEnd: `${endYear}-01-31`,
    };
  }
  if (dept.includes("outdoor") || dept.includes("patio") || dept.includes("garden")) {
    const start = lastCompletedSeasonStart(3, today); // April
    const endYear = new Date(start).getFullYear();
    return {
      kind: "season",
      title: "Outdoor season",
      message:
        "Data shows the active season is April 1 to August 31 (June peaks at 15% of annual; Oct is the annual trough — outdoor does not ride the holiday wave).",
      seasonStart: start,
      seasonEnd: `${endYear}-08-31`,
    };
  }
  if (
    dept.includes("apparel") ||
    dept.includes("women") ||
    dept.includes("men") ||
    dept.includes("accessor") ||
    dept.includes("jewel")
  ) {
    return {
      kind: "apparel",
      title: "Apparel reporting",
      message:
        "PO receipts are not currently imported for Apparel — the On Order column may be 0 even when orders are en route. On-hand and sold are trustworthy. Sales show three peaks per year: Dec (gifts), May (women's spring), Aug (back-to-school).",
    };
  }
  if (dept.includes("rug")) {
    return {
      kind: "rugs",
      title: "Rugs",
      message:
        "Rugs are consignment inventory. The traditional on-hand / on-order math here isn't the right model. A dedicated Rugs Buying Guide with size × quality pivots is shipping next — for now, use the Consignment pages for rug inventory.",
    };
  }
  return null;
}

// Apply a saved-view filter recursively. Keeps a node if it matches OR any
// descendant does -- so drilling into a group that has matching children
// (but doesn't itself match) still works as expected.
function applySavedView(nodes: BuyersNode[], view: SavedView): BuyersNode[] {
  if (view === "all") return nodes;
  const matches = (n: BuyersNode): boolean => {
    switch (view) {
      case "top-sellers":
        return n.soldQty > 0;
      case "dead-stock":
        return n.onHand > 0 && n.soldQty === 0;
      case "running-low":
        return n.weeksSupply !== null && n.weeksSupply < 2 && n.soldQty > 0;
      case "new-not-moving":
        return n.soldQty === 0 && (n.onHand > 0 || n.onOrder > 0);
    }
  };
  const walk = (n: BuyersNode): BuyersNode | null => {
    const keptChildren = n.children.map(walk).filter((c): c is BuyersNode => c !== null);
    if (matches(n) || keptChildren.length > 0) {
      return { ...n, children: keptChildren };
    }
    return null;
  };
  return nodes.map(walk).filter((n): n is BuyersNode => n !== null);
}

// Walk the filtered tree to the currently-drilled node by ID path. If a
// breadcrumb's node was filtered out by the active saved view, fall back
// to whatever depth still exists.
function navigate(
  roots: BuyersNode[],
  path: string[],
): { children: BuyersNode[]; reachedDepth: number } {
  let cursor: BuyersNode[] = roots;
  let reachedDepth = 0;
  for (const id of path) {
    const next = cursor.find((n) => n.id === id);
    if (!next) break;
    cursor = next.children;
    reachedDepth += 1;
  }
  return { children: cursor, reachedDepth };
}

// Flatten all product-leaf nodes under a set of roots. Used to source the
// Attention Panel lists.
function flattenLeaves(nodes: BuyersNode[]): BuyersNode[] {
  const out: BuyersNode[] = [];
  const walk = (n: BuyersNode) => {
    if (n.productId !== null) out.push(n);
    else for (const c of n.children) walk(c);
  };
  for (const n of nodes) walk(n);
  return out;
}

function sumBaseline() {
  return {
    productCount: 0,
    onHand: 0,
    customerStock: 0,
    onOrder: 0,
    soldQty: 0,
    soldTotal: 0,
    soldCost: 0,
    costEstimated: false,
  };
}

function sumNodes(nodes: BuyersNode[]) {
  return nodes.reduce((acc, n) => {
    acc.productCount += n.productCount;
    acc.onHand += n.onHand;
    acc.customerStock += n.customerStock;
    acc.onOrder += n.onOrder;
    acc.soldQty += n.soldQty;
    acc.soldTotal += n.soldTotal;
    acc.soldCost += n.soldCost;
    if (n.costEstimated) acc.costEstimated = true;
    return acc;
  }, sumBaseline());
}

function downloadCsv(nodes: BuyersNode[], crumbLabels: string[], pivot: BuyersPivot) {
  // Dump every leaf product under the currently-scoped view. Buyers want
  // the rollups on screen; CSV consumers want the raw per-product rows to
  // re-pivot in their own tools.
  const leaves = flattenLeaves(nodes);
  const header = [
    "Scope",
    "Pivot",
    "Part # / Frame",
    "Variants",
    "On Hand",
    "Customer Stock",
    "On Order",
    "Stock Sold Qty",
    "Stock Sold $",
    "Special Sold Qty",
    "Special Sold $",
    "Sold Qty",
    "Sold $",
    "Sold Cost",
    "Margin %",
    "Cost Estimated",
    "Sell-through %",
    "Weeks Supply",
    "Last Sold",
  ];
  const scope = crumbLabels.length === 0 ? "All" : crumbLabels.join(" > ");
  const rows = [header.join(",")];
  for (const l of leaves) {
    rows.push(
      [
        JSON.stringify(scope),
        pivot,
        JSON.stringify(l.name),
        l.productCount,
        l.onHand,
        l.customerStock,
        l.onOrder,
        l.stockSoldQty,
        l.stockSoldTotal,
        l.specialSoldQty,
        l.specialSoldTotal,
        l.soldQty,
        l.soldTotal,
        l.soldCost,
        l.avgMarginPct ?? "",
        l.costEstimated ? "yes" : "no",
        l.sellThroughPct,
        l.weeksSupply ?? "",
        l.lastSold ?? "",
      ].join(","),
    );
  }
  const blob = new Blob([rows.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `buyers-${pivot}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function BuyersReportView() {
  const money = useMoneyFormatter();
  const currency = (v: number) => money(v, { whole: true });
  const utils = api.useUtils();

  // Defaults: trailing 365 days gives a full-season comparison for
  // most departments; vendor pivot is the buyers' primary mental model
  // (they work with vendor reps, not with our internal departments).
  const [startDate, setStartDate] = useState(
    format(startOfDay(subDays(new Date(), 365)), "yyyy-MM-dd"),
  );
  const [endDate, setEndDate] = useState(format(endOfDay(new Date()), "yyyy-MM-dd"));
  const [pivot, setPivot] = useState<BuyersPivot>("vendor");
  const [savedView, setSavedView] = useState<SavedView>("all");
  const [rollupFrames, setRollupFrames] = useState(false);
  // Drill state: array of node IDs from root down to current position.
  const [drillIds, setDrillIds] = useState<string[]>([]);
  // Label cache so breadcrumb can render names even after re-filtering.
  const [crumbLabels, setCrumbLabels] = useState<string[]>([]);
  // Inline "where is this?" expansion under leaf product rows. Keyed by
  // BuyersNode.id (e.g. "part:42"). Cache responses so re-expanding is
  // instant.
  const [expandedLeafId, setExpandedLeafId] = useState<string | null>(null);
  const [positionsCache, setPositionsCache] = useState<Map<string, PositionsResponse>>(new Map());
  const [positionsLoading, setPositionsLoading] = useState<string | null>(null);

  const queryInput = useMemo(
    () => ({ startDate, endDate, pivot, rollupFrames }),
    [startDate, endDate, pivot, rollupFrames],
  );

  // Summary auto-runs on any filter change — react-query keys by queryInput and
  // refetches when it changes, matching the legacy effect-driven auto-run. The
  // "Run" button force-refetches the current input.
  const query = api.reports.buyersSummary.useQuery(queryInput);
  const data = query.data ?? null;
  const loading = query.isFetching;

  // Surface a backend error in a toast (the legacy axios .catch did the same).
  useEffect(() => {
    if (query.error) {
      toast.error(getErrorMessage(query.error, "Failed to load Buyers Report"));
    }
  }, [query.error]);

  // Reset the drill path. The legacy load() cleared drillIds/crumbLabels on
  // every successful fetch AND whenever the pivot changed (IDs from one pivot
  // tree don't exist under the other). We call this from each filter-change
  // handler + the Run button instead of an effect (repo convention — avoids
  // set-state-in-effect; mirrors SalesBySalespersonView's resetDrilldowns).
  function resetDrill() {
    setDrillIds([]);
    setCrumbLabels([]);
  }

  const filteredRoots = useMemo(
    () => (data ? applySavedView(data.groups, savedView) : []),
    [data, savedView],
  );

  const { children: visibleRows, reachedDepth } = useMemo(
    () => navigate(filteredRoots, drillIds),
    [filteredRoots, drillIds],
  );

  // Align crumbs with the actual depth we navigated to. If the saved
  // view filtered out the currently-drilled node, truncate gracefully.
  const effectiveCrumbs = useMemo(
    () => crumbLabels.slice(0, reachedDepth),
    [crumbLabels, reachedDepth],
  );

  const deptHint = useMemo(
    () => getDeptHint(effectiveCrumbs, pivot, new Date()),
    [effectiveCrumbs, pivot],
  );

  const scopeTotals = useMemo(() => {
    const t = sumNodes(visibleRows);
    const avgMarginPct =
      t.soldTotal > 0 ? Math.round(((t.soldTotal - t.soldCost) / t.soldTotal) * 1000) / 10 : null;
    return { ...t, avgMarginPct };
  }, [visibleRows]);

  // Attention Panel — top-5 "running thin" (selling fast, nearly out),
  // top-5 "dead money" (on hand, not moving), and top-5 "hidden demand"
  // (zero on floor, but customer stock/special orders prove people buy
  // it -- keep a sample on the floor). All scoped to the current drilled
  // context so the recommendations are actionable, not academic.
  const attention = useMemo(() => {
    const leaves = flattenLeaves(visibleRows);
    const runningThin = leaves
      .filter((l) => l.weeksSupply !== null && l.weeksSupply < 2 && l.soldQty > 0)
      .sort((a, b) => b.soldQty - a.soldQty)
      .slice(0, 5);
    const deadMoney = leaves
      .filter((l) => l.onHand > 0 && l.soldQty === 0)
      .sort((a, b) => b.soldCost - a.soldCost)
      .slice(0, 5);
    const deadMoneyDollars = deadMoney.reduce((s, l) => s + l.soldCost, 0);
    const hiddenDemand = leaves
      .filter((l) => l.onHand === 0 && (l.customerStock > 0 || l.specialSoldQty > 0))
      .sort((a, b) => b.customerStock + b.specialSoldQty - (a.customerStock + a.specialSoldQty))
      .slice(0, 5);
    return { runningThin, deadMoney, deadMoneyDollars, hiddenDemand };
  }, [visibleRows]);

  async function drillInto(node: BuyersNode) {
    if (node.productId !== null) {
      // Product leaf — expand inline to show locations. Second click
      // collapses. Use "View product" link in the sub-table to navigate.
      if (expandedLeafId === node.id) {
        setExpandedLeafId(null);
        return;
      }
      setExpandedLeafId(node.id);
      if (!positionsCache.has(node.id)) {
        const productId = node.productId;
        setPositionsLoading(node.id);
        try {
          const res = await utils.reports.buyersPositions.fetch({ productId });
          setPositionsCache((prev) => {
            const next = new Map(prev);
            next.set(node.id, res);
            return next;
          });
        } catch (err) {
          toast.error(getErrorMessage(err, "Failed to load locations for this product"));
        } finally {
          setPositionsLoading(null);
        }
      }
      return;
    }
    if (node.children.length === 0) {
      // Frame leaf (multiple products collapsed). No single detail
      // page; buyer can un-toggle "Roll up frames" to see variants.
      return;
    }
    setDrillIds((prev) => [...prev, node.id]);
    setCrumbLabels((prev) => [...prev, node.name]);
  }

  function drillUpTo(depth: number) {
    setDrillIds((prev) => prev.slice(0, depth));
    setCrumbLabels((prev) => prev.slice(0, depth));
  }

  return (
    <div className="space-y-6 font-serif">
      <nav className="text-sm text-sh-gray">
        <Link href="/app/reports" className="hover:underline">
          Reports
        </Link>
        <span className="mx-2">/</span>
        <span className="text-sh-black">Buyers Report</span>
      </nav>
      <div>
        <h1 className="text-2xl font-semibold text-sh-navy">Buyers Report</h1>
        <p className="text-sm text-sh-gray mt-1">
          On hand, on order, and sold in one view. Pivot by department or by vendor. Click any row
          to drill down — each click takes you one level deeper (Department → Category → Type →
          Vendor → Part #). Headline numbers re-scope to wherever you&apos;re drilled.
        </p>
      </div>

      {/* Filter bar */}
      <div className="bg-white border border-sh-gray/15 rounded-xl p-5 flex flex-wrap items-end gap-4">
        <div>
          <label
            htmlFor="buyers-from"
            className="block text-xs font-semibold text-sh-gray uppercase tracking-wider mb-1"
          >
            From
          </label>
          <input
            id="buyers-from"
            type="date"
            value={startDate}
            onChange={(e) => {
              setStartDate(e.target.value);
              resetDrill();
            }}
            className="border border-sh-gray/30 rounded-lg px-3 py-2 text-sm min-h-[44px]"
          />
        </div>
        <div>
          <label
            htmlFor="buyers-to"
            className="block text-xs font-semibold text-sh-gray uppercase tracking-wider mb-1"
          >
            To
          </label>
          <input
            id="buyers-to"
            type="date"
            value={endDate}
            onChange={(e) => {
              setEndDate(e.target.value);
              resetDrill();
            }}
            className="border border-sh-gray/30 rounded-lg px-3 py-2 text-sm min-h-[44px]"
          />
        </div>
        <div>
          <label
            htmlFor="buyers-pivot"
            className="block text-xs font-semibold text-sh-gray uppercase tracking-wider mb-1"
          >
            Pivot
          </label>
          <select
            id="buyers-pivot"
            value={pivot}
            onChange={(e) => {
              setPivot(e.target.value as BuyersPivot);
              resetDrill();
            }}
            className="border border-sh-gray/30 rounded-lg px-3 py-2 text-sm min-h-[44px]"
          >
            <option value="department">By Department</option>
            <option value="vendor">By Vendor</option>
          </select>
        </div>
        <div className="flex items-end">
          <label className="flex items-center gap-2 cursor-pointer min-h-[44px] text-sm text-sh-black">
            <input
              type="checkbox"
              checked={rollupFrames}
              onChange={(e) => {
                setRollupFrames(e.target.checked);
                resetDrill();
              }}
              className="h-4 w-4"
            />
            <span>Roll up frames</span>
          </label>
        </div>
        <Button
          onClick={() => {
            resetDrill();
            query.refetch();
          }}
          disabled={loading}
          className="min-h-[44px]"
        >
          {loading ? "Loading..." : "Run"}
        </Button>
        {data && visibleRows.length > 0 && (
          <Button
            variant="outline"
            onClick={() => downloadCsv(visibleRows, effectiveCrumbs, pivot)}
            className="min-h-[44px] flex items-center gap-2"
          >
            <Download className="w-4 h-4" /> Export CSV
          </Button>
        )}
      </div>

      {/* Saved view chips */}
      <div className="flex flex-wrap gap-2">
        {SAVED_VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            title={v.hint}
            onClick={() => setSavedView(v.id)}
            className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
              savedView === v.id
                ? "bg-sh-blue text-white border-sh-blue"
                : "border-sh-gray/30 text-sh-gray hover:border-sh-blue"
            }`}
          >
            {v.label}
          </button>
        ))}
      </div>

      {data && (
        <>
          {/* Breadcrumb */}
          <div className="flex flex-wrap items-center gap-1 text-sm">
            <button
              onClick={() => drillUpTo(0)}
              className={`${effectiveCrumbs.length === 0 ? "text-sh-navy font-semibold" : "text-sh-blue hover:underline"}`}
            >
              All
            </button>
            {effectiveCrumbs.map((label, i) => (
              <span key={i} className="flex items-center gap-1">
                <ChevronRight className="w-3 h-3 text-sh-gray" />
                <button
                  onClick={() => drillUpTo(i + 1)}
                  className={`${i === effectiveCrumbs.length - 1 ? "text-sh-navy font-semibold" : "text-sh-blue hover:underline"}`}
                >
                  {label}
                </button>
              </span>
            ))}
          </div>

          {/* Department hint banner */}
          {deptHint && (
            <div
              className={`rounded-xl border p-4 ${
                deptHint.kind === "season"
                  ? "bg-sh-linen border-sh-gold/40"
                  : "bg-white border-sh-gray/25"
              }`}
            >
              <h3 className="text-sm font-semibold text-sh-navy mb-1">{deptHint.title}</h3>
              <p className="text-xs text-sh-gray">{deptHint.message}</p>
              {deptHint.kind === "season" && deptHint.seasonStart && deptHint.seasonEnd && (
                <div className="mt-3 flex items-center gap-3 text-xs">
                  <span className="text-sh-gray">
                    Season: {deptHint.seasonStart} → {deptHint.seasonEnd}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setStartDate(deptHint.seasonStart!);
                      setEndDate(deptHint.seasonEnd!);
                    }}
                  >
                    Apply season range
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* KPI strip — scoped to current drill level */}
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
            <KpiCard
              label="On Hand"
              size="compact"
              value={num(scopeTotals.onHand)}
              sub={<span className="text-xs text-sh-gray">floor, available to sell</span>}
            />
            <KpiCard
              label="Cust Stock"
              size="compact"
              value={num(scopeTotals.customerStock)}
              sub={<span className="text-xs text-sh-gray">allocated to open orders</span>}
            />
            <KpiCard label="On Order" size="compact" value={num(scopeTotals.onOrder)} />
            <KpiCard label="Sold Qty" size="compact" value={num(scopeTotals.soldQty)} />
            <KpiCard label="Sold $" size="compact" value={currency(scopeTotals.soldTotal)} />
            <KpiCard
              label="Margin"
              size="compact"
              value={formatScopeMargin(scopeTotals.avgMarginPct, scopeTotals.costEstimated)}
              sub={
                scopeTotals.costEstimated ? (
                  <span className="text-xs text-sh-gray">* includes retail/2 estimates</span>
                ) : undefined
              }
            />
          </div>

          {/* Attention Panel */}
          <AttentionPanel
            runningThin={attention.runningThin}
            deadMoney={attention.deadMoney}
            deadMoneyDollars={attention.deadMoneyDollars}
            hiddenDemand={attention.hiddenDemand}
            currency={currency}
          />

          <ReportSection
            title={sectionTitle(pivot, effectiveCrumbs, visibleRows.length)}
            description="Click any row to drill in. Click a breadcrumb to step back up. Leaf rows link to the product page."
          >
            {visibleRows.length === 0 ? (
              <p className="text-sm text-sh-gray py-4">Nothing matches this saved view.</p>
            ) : (
              <div className="bg-white rounded-xl border border-sh-gray/15 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-sh-gray/15 bg-sh-linen text-[10px] uppercase tracking-wide text-sh-gray">
                      <th className="text-left px-2 py-2 font-semibold">
                        {depthLabel(pivot, effectiveCrumbs.length)}
                      </th>
                      <th className="text-right px-2 py-2 font-semibold">Products</th>
                      <th
                        className="text-right px-2 py-2 font-semibold"
                        title="Floor stock -- available to sell"
                      >
                        On Hand
                      </th>
                      <th
                        className="text-right px-2 py-2 font-semibold"
                        title="Customer-allocated inventory in the building (already sold, not yet delivered)"
                      >
                        Cust Stock
                      </th>
                      <th className="text-right px-2 py-2 font-semibold">On Order</th>
                      <th
                        className="text-right px-2 py-2 font-semibold"
                        title="Sold from floor stock (bought for inventory, resold as-is)"
                      >
                        Stock Sold
                      </th>
                      <th
                        className="text-right px-2 py-2 font-semibold"
                        title="Sold as special-order (PO cut for a specific customer order)"
                      >
                        Special Sold
                      </th>
                      <th className="text-right px-2 py-2 font-semibold">Sold $</th>
                      <th className="text-right px-2 py-2 font-semibold">Sold Cost</th>
                      <th className="text-right px-2 py-2 font-semibold">Margin</th>
                      <th className="text-right px-2 py-2 font-semibold">Sell-thru</th>
                      <th className="text-right px-2 py-2 font-semibold">Wks</th>
                      <th className="text-left px-2 py-2 font-semibold">Last Sold</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((n, i) => (
                      <Fragment key={n.id}>
                        <Row
                          node={n}
                          zebra={i % 2 === 1}
                          onClick={() => drillInto(n)}
                          expanded={expandedLeafId === n.id}
                        />
                        {expandedLeafId === n.id && (
                          <PositionsRow
                            node={n}
                            loading={positionsLoading === n.id}
                            data={positionsCache.get(n.id) ?? null}
                          />
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-xs text-sh-gray mt-2">
              Margin = (Sold $ − Sold Cost) / Sold $. Sold Cost uses the line&apos;s actual cost
              when the POS has it, falls back to the product&apos;s base cost × quantity, then to
              retail ÷ 2 as a last resort. An asterisk (*) marks rows whose margin includes at least
              one retail/2 estimate — treat those figures as directional until receiving data fills
              in.
            </p>
          </ReportSection>
        </>
      )}

      {!data && !loading && (
        <p className="text-sh-gray text-center py-16">Select filters and click Run.</p>
      )}
    </div>
  );
}

function Row({
  node,
  zebra,
  onClick,
  expanded = false,
}: Readonly<{
  node: BuyersNode;
  zebra: boolean;
  onClick: () => void;
  expanded?: boolean;
}>) {
  const fmtWeeks = (w: number | null) => (w === null ? "—" : `${w.toFixed(1)}w`);
  const marginTitle = node.costEstimated
    ? "Margin includes retail/2 estimates because some lines have no true cost in the POS yet."
    : undefined;
  // Leaf = no children. Could be a single product (productId set) or a
  // rolled-up frame (productId null, productCount = variants collapsed).
  const isLeaf = node.children.length === 0;
  const isFrame = isLeaf && node.productId === null;
  return (
    <tr
      className={`border-b border-sh-gray/10 cursor-pointer hover:bg-sh-linen transition ${zebra ? "bg-sh-stripe" : ""}`}
      onClick={onClick}
    >
      <td className="px-2 py-2 whitespace-nowrap font-semibold text-sh-navy">
        <span className="inline-flex items-center gap-2">
          {!isLeaf && <ChevronRight className="w-3 h-3 text-sh-gray" />}
          {isLeaf && !isFrame && node.productId !== null && (
            <MapPin
              className={`w-3 h-3 transition-colors ${expanded ? "text-sh-blue" : "text-sh-gray"}`}
            />
          )}
          <span>{node.name}</span>
          {isFrame && (
            <span className="text-xs text-sh-gray font-normal">
              ({node.productCount} variant{node.productCount === 1 ? "" : "s"})
            </span>
          )}
        </span>
      </td>
      <td className="px-2 py-2 whitespace-nowrap text-right text-sh-gray">
        {node.productCount.toLocaleString()}
      </td>
      <td className="px-2 py-2 whitespace-nowrap text-right">{node.onHand.toLocaleString()}</td>
      <td
        className={`px-2 py-2 whitespace-nowrap text-right ${
          node.customerStock > 0 ? "text-sh-navy" : "text-sh-gray"
        }`}
      >
        {node.customerStock.toLocaleString()}
      </td>
      <td className="px-2 py-2 whitespace-nowrap text-right">{node.onOrder.toLocaleString()}</td>
      <td className="px-2 py-2 whitespace-nowrap text-right">
        {node.stockSoldQty.toLocaleString()}
      </td>
      <td className="px-2 py-2 whitespace-nowrap text-right">
        {node.specialSoldQty.toLocaleString()}
      </td>
      <td className="px-2 py-2 whitespace-nowrap text-right font-medium">
        {node.soldTotal.toLocaleString("en-US", {
          style: "currency",
          currency: "USD",
          maximumFractionDigits: 0,
        })}
      </td>
      <td
        className={`px-2 py-2 whitespace-nowrap text-right ${node.costEstimated ? "text-sh-gray italic" : "text-sh-gray"}`}
        title={marginTitle}
      >
        {node.soldCost.toLocaleString("en-US", {
          style: "currency",
          currency: "USD",
          maximumFractionDigits: 0,
        })}
      </td>
      <td
        className="px-2 py-2 whitespace-nowrap text-right text-sh-navy font-medium"
        title={marginTitle}
      >
        {formatScopeMargin(node.avgMarginPct, node.costEstimated)}
      </td>
      <td className="px-2 py-2 whitespace-nowrap text-right text-sh-gray">
        {node.sellThroughPct}%
      </td>
      <td className="px-2 py-2 whitespace-nowrap text-right text-sh-gray">
        {fmtWeeks(node.weeksSupply)}
      </td>
      <td className="px-2 py-2 whitespace-nowrap text-sh-gray">{formatDate(node.lastSold)}</td>
    </tr>
  );
}

function PositionsRow({
  node,
  loading,
  data,
}: Readonly<{
  node: BuyersNode;
  loading: boolean;
  data: PositionsResponse | null;
}>) {
  return (
    <tr>
      <td colSpan={12} className="bg-sh-linen/50 px-6 py-3 border-b border-sh-gray/10">
        {loading && <p className="text-xs text-sh-gray">Loading locations…</p>}
        {!loading && !data && <p className="text-xs text-sh-gray">No position data returned.</p>}
        {!loading && data && (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-4 text-xs">
              <div className="text-sh-gray">
                <span className="font-semibold text-sh-navy">{data.productNumber}</span>
                {data.productName && <span> — {data.productName}</span>}
                {data.vendorName && <span className="ml-2">· {data.vendorName}</span>}
              </div>
              {node.productId !== null && (
                <a
                  href={`/products/${node.productId}`}
                  className="inline-flex items-center gap-1 text-sh-blue hover:underline"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink className="w-3 h-3" />
                  View product
                </a>
              )}
            </div>
            {data.positions.length === 0 ? (
              <p className="text-xs text-sh-gray italic">
                No on-hand inventory positions. On order: {data.totalOnOrder}
                {data.earliestEsd
                  ? ` (earliest ${new Date(data.earliestEsd).toLocaleDateString()})`
                  : ""}
              </p>
            ) : (
              <>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wide text-sh-gray">
                      <th className="text-left px-2 py-1 font-semibold">Store</th>
                      <th className="text-left px-2 py-1 font-semibold">Stock Location</th>
                      <th className="text-right px-2 py-1 font-semibold">Floor</th>
                      <th className="text-right px-2 py-1 font-semibold">Customer</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.positions.map((p, i) => (
                      <tr key={i} className="border-t border-sh-gray/10">
                        <td className="px-2 py-1 text-sh-gray">{p.storeName || "—"}</td>
                        <td className="px-2 py-1 text-sh-black">
                          {p.locationCode ? (
                            <span className="text-sh-gray mr-2">{p.locationCode}</span>
                          ) : null}
                          {p.locationName || "(no location)"}
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums">
                          {p.floorQty > 0 ? p.floorQty.toLocaleString() : "—"}
                        </td>
                        <td
                          className={`px-2 py-1 text-right tabular-nums ${
                            p.customerQty > 0 ? "text-sh-navy font-medium" : "text-sh-gray"
                          }`}
                        >
                          {p.customerQty > 0 ? p.customerQty.toLocaleString() : "—"}
                        </td>
                      </tr>
                    ))}
                    <tr className="border-t-2 border-sh-gray/25 font-semibold">
                      <td colSpan={2} className="px-2 py-1 text-sh-navy">
                        Totals
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums text-sh-navy">
                        {data.totalFloor.toLocaleString()}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums text-sh-navy">
                        {data.totalCustomer.toLocaleString()}
                      </td>
                    </tr>
                  </tbody>
                </table>
                {data.totalOnOrder > 0 && (
                  <p className="text-xs text-sh-gray">
                    On order: {data.totalOnOrder.toLocaleString()}
                    {data.earliestEsd
                      ? ` · earliest arrival ${new Date(data.earliestEsd).toLocaleDateString()}`
                      : ""}
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

function AttentionPanel({
  runningThin,
  deadMoney,
  deadMoneyDollars,
  hiddenDemand,
  currency,
}: Readonly<{
  runningThin: BuyersNode[];
  deadMoney: BuyersNode[];
  deadMoneyDollars: number;
  hiddenDemand: BuyersNode[];
  currency: (v: number) => string;
}>) {
  if (runningThin.length === 0 && deadMoney.length === 0 && hiddenDemand.length === 0) return null;
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      <div className="bg-white border border-sh-gold/40 rounded-xl p-4">
        <div className="flex items-center gap-2 mb-2">
          <AlertTriangle className="w-4 h-4 text-sh-gold" />
          <h3 className="text-sm font-semibold text-sh-navy">Opportunity — running thin</h3>
        </div>
        {runningThin.length === 0 ? (
          <p className="text-xs text-sh-gray">
            No products in this scope are selling fast with fewer than 2 weeks of stock. Good.
          </p>
        ) : (
          <>
            <p className="text-xs text-sh-gray mb-2">
              {runningThin.length} product{runningThin.length === 1 ? "" : "s"} selling fast with
              less than 2 weeks of stock. Likely missing sales unless reordered soon.
            </p>
            <ul className="space-y-1 text-xs">
              {runningThin.map((l) => (
                <li key={l.id} className="flex justify-between gap-2">
                  <span className="text-sh-black truncate">{l.name}</span>
                  <span className="text-sh-gray whitespace-nowrap tabular-nums">
                    {num(l.soldQty)} sold · {l.weeksSupply?.toFixed(1)}w left
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="bg-white border border-sh-gray/30 rounded-xl p-4">
        <div className="flex items-center gap-2 mb-2">
          <Archive className="w-4 h-4 text-sh-gray" />
          <h3 className="text-sm font-semibold text-sh-navy">Dead money — sitting too deep</h3>
        </div>
        {deadMoney.length === 0 ? (
          <p className="text-xs text-sh-gray">
            No on-hand stock in this scope with zero sales. Clean floor.
          </p>
        ) : (
          <>
            <p className="text-xs text-sh-gray mb-2">
              {deadMoney.length} product{deadMoney.length === 1 ? "" : "s"} with on-hand stock and
              zero sales in range. Tied-up cost:{" "}
              <span className="font-semibold text-sh-navy">{currency(deadMoneyDollars)}</span>.
            </p>
            <ul className="space-y-1 text-xs">
              {deadMoney.map((l) => (
                <li key={l.id} className="flex justify-between gap-2">
                  <span className="text-sh-black truncate">{l.name}</span>
                  <span className="text-sh-gray whitespace-nowrap tabular-nums">
                    {num(l.onHand)} on hand · {currency(l.soldCost)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="bg-white border border-sh-blue/40 rounded-xl p-4">
        <div className="flex items-center gap-2 mb-2">
          <Eye className="w-4 h-4 text-sh-blue" />
          <h3 className="text-sm font-semibold text-sh-navy">
            Hidden demand — worth a floor sample
          </h3>
        </div>
        {hiddenDemand.length === 0 ? (
          <p className="text-xs text-sh-gray">
            Nothing in this scope is selling as special-order or sitting allocated without a floor
            sample.
          </p>
        ) : (
          <>
            <p className="text-xs text-sh-gray mb-2">
              {hiddenDemand.length} product{hiddenDemand.length === 1 ? "" : "s"} with zero on-hand
              but proven demand (customer-allocated units or special-order sales). Candidates for a
              floor sample.
            </p>
            <ul className="space-y-1 text-xs">
              {hiddenDemand.map((l) => (
                <li key={l.id} className="flex justify-between gap-2">
                  <span className="text-sh-black truncate">{l.name}</span>
                  <span className="text-sh-gray whitespace-nowrap tabular-nums">
                    {l.customerStock > 0 ? `${num(l.customerStock)} cust` : ""}
                    {l.customerStock > 0 && l.specialSoldQty > 0 ? " · " : ""}
                    {l.specialSoldQty > 0 ? `${num(l.specialSoldQty)} special` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
