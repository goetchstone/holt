"use client";

// /app/src/app/(dashboard)/app/admin/buyer-drafts/buy/[id]/performance/BuyPerformanceView.tsx
//
// Per-Buy performance dashboard body. App Router port of the legacy
// admin/buyer-drafts/buy/[id]/performance body (minus MainLayout chrome, which
// the (dashboard) layout supplies).
//
// Two-pane layout when a compare-to-buy exists; single pane otherwise. Each pane
// shows header KPIs + a per-frame table with status badges. Frame rows merge
// multiple drafts on the same frame (different grades / fabrics of the same sofa)
// into a single line. Sales attribution uses lib/frameRollup.ts to count variant
// sales toward the same frame. Excludes Marjan vendors (no shared frame stems).
// Reads the shared /api/admin/buyer-drafts/buys/[id]/performance + /linked-pos
// REST endpoints.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import axios from "axios";
import { toast } from "react-toastify";
import {
  Loader2,
  ArrowLeft,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  Pause,
  PackageCheck,
  CircleAlert,
} from "lucide-react";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { getErrorMessage } from "@/lib/toastError";

type FrameStatus = "no-link" | "dead" | "underbuy" | "healthy" | "soft" | "pending";

interface FrameRow {
  frameKey: string;
  frameLabel: string;
  qtyOrdered: number;
  /** Phase 6.8 -- total receipts across stock + special variants on this frame. */
  qtyReceived: number;
  qtyStockReceived: number;
  qtySpecialReceived: number;
  qtySold: number;
  /** Phase 6.3 -- stock = sales of the buyer's drafted (linked) products. */
  qtyStockSold: number;
  /** Phase 6.3 -- special = sales of OTHER variants of the same frame. */
  qtySpecialSold: number;
  totalCost: number;
  revenue: number;
  stockRevenue: number;
  specialRevenue: number;
  costOfSold: number;
  stockCostOfSold: number;
  specialCostOfSold: number;
  grossProfit: number;
  marginRatio: number;
  /** Phase 6.11 -- margin from stock sales only. */
  stockMarginRatio: number;
  /** Phase 6.11 -- margin from special sales only. */
  specialMarginRatio: number;
  sellThroughRatio: number;
  /** qtyStockSold / qtyOrdered -- drives the status hint. */
  stockSellThroughRatio: number;
  status: FrameStatus;
  draftCount: number;
  hasAnyLink: boolean;
  /** 2026-05-13 -- true when any sold line had cost = 0 / null and fell back to
   *  revenue / 2 (50% margin baseline). UI marks the row's cost/margin cells with
   *  "(est)" so the buyer knows the number is inferred, not measured. */
  hasEstimatedCost: boolean;
}

interface PerformanceResponse {
  buy: {
    id: number;
    name: string;
    season: string | null;
    year: number | null;
    status: string;
    budget: string | null;
    daysSinceExported: number;
  };
  rollup: {
    totalSpent: number;
    totalRevenue: number;
    totalGrossProfit: number;
    overallMargin: number;
    totalQtyOrdered: number;
    totalQtyReceived: number;
    totalQtyStockReceived: number;
    totalQtySpecialReceived: number;
    totalQtySold: number;
    totalQtyStockSold: number;
    totalQtySpecialSold: number;
    overallSellThrough: number;
    overallStockSellThrough: number;
  };
  frames: FrameRow[];
  compareTo: { id: number; name: string; year: number | null; season: string | null } | null;
  // Slice 6.2 (2026-05-12) -- sales-window context. start=null + source
  // "fallback-full-history" means no PO has an ETA set yet; UI shows the warning
  // so the buyer knows to set one.
  salesWindow: {
    start: string | null;
    end: string;
    source:
      "actualReceivedDate" | "expectedDeliveryDate" | "expectedShipMonth" | "fallback-full-history";
    message: string;
  };
}

const STATUS_LABELS: Record<FrameStatus, string> = {
  "no-link": "No link yet",
  dead: "Dead",
  underbuy: "Underbuy",
  healthy: "Healthy",
  soft: "Soft",
  pending: "Too early",
};

const STATUS_STYLES: Record<FrameStatus, string> = {
  "no-link": "bg-sh-stripe text-sh-gray",
  dead: "bg-red-100 text-red-800",
  underbuy: "bg-sh-gold/20 text-sh-gold",
  healthy: "bg-emerald-100 text-emerald-700",
  soft: "bg-yellow-100 text-yellow-800",
  pending: "bg-sh-blue/10 text-sh-blue",
};

function fmtPct(ratio: number): string {
  if (!Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(0)}%`;
}

// Phase 6.11 -- tooltip explaining the margin split on hover. Shows the breakdown
// for buyers who want the math, with the cost-fallback note when applicable.
function marginTitle(f: FrameRow): string {
  const breakdown =
    f.qtySpecialSold > 0
      ? [
          `Stock margin: ${fmtPct(f.stockMarginRatio)} (the buyer's plan)`,
          `Special margin: ${fmtPct(f.specialMarginRatio)} (customer-spec orders)`,
          `Combined: ${fmtPct(f.marginRatio)}`,
        ]
      : [`Margin: ${fmtPct(f.marginRatio)}`];
  const estimated = f.hasEstimatedCost
    ? ["Estimated — one or more sold lines had no cost; fallback uses revenue/2."]
    : [];
  return [...breakdown, ...estimated].join("\n");
}

function formatPoDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function BuyPerformanceView({ id }: Readonly<{ id: string }>) {
  const [primary, setPrimary] = useState<PerformanceResponse | null>(null);
  const [compare, setCompare] = useState<PerformanceResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const primaryRes = await axios.get<PerformanceResponse>(
        `/api/admin/buyer-drafts/buys/${id}/performance`,
      );
      setPrimary(primaryRes.data);
      if (primaryRes.data.compareTo) {
        const compareRes = await axios.get<PerformanceResponse>(
          `/api/admin/buyer-drafts/buys/${primaryRes.data.compareTo.id}/performance`,
        );
        setCompare(compareRes.data);
      } else {
        setCompare(null);
      }
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to load performance"));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading || !primary) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-sh-gold" />
      </div>
    );
  }

  return (
    <div className="px-6 py-8 max-w-screen-xl mx-auto">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <Link
            href="/app/admin/buyer-drafts"
            className="text-sm text-sh-blue hover:underline inline-flex items-center gap-1"
          >
            <ArrowLeft className="h-3 w-3" /> Back to buyer drafts
          </Link>
          <h1 className="font-serif text-3xl text-sh-navy mt-2">
            Performance — {primary.buy.name}
          </h1>
          <p className="text-sm text-sh-gray mt-1">
            Frame-aware sell-through, margin, and status hints for each frame in this Buy. Excludes
            Marjan consignment.
          </p>
        </div>
      </div>

      <div className={`grid gap-6 ${compare ? "lg:grid-cols-2" : "lg:grid-cols-1"}`}>
        <PerformancePane data={primary} isPrimary={true} />
        {compare && <PerformancePane data={compare} isPrimary={false} />}
      </div>

      <LinkedRealPosPanel buyId={primary.buy.id} />
    </div>
  );
}

function PerformancePane({
  data,
  isPrimary,
}: Readonly<{ data: PerformanceResponse; isPrimary: boolean }>) {
  const formatMoney = useMoneyFormatter();
  const { buy, rollup, frames, salesWindow } = data;
  const isFallbackWindow = salesWindow.source === "fallback-full-history";
  const overBudget = buy.budget ? Number(buy.budget) < rollup.totalSpent : false;
  return (
    <section className="bg-white border border-sh-stripe rounded-lg p-4">
      <header className="mb-4">
        <div className="text-xs uppercase tracking-wide text-sh-gray">
          {isPrimary ? "This buy" : "Compare to"}
        </div>
        <h2 className="font-serif text-xl text-sh-navy">
          {buy.name}
          {buy.season && buy.year && (
            <span className="text-sh-gray text-base ml-2">
              ({buy.season} {buy.year})
            </span>
          )}
        </h2>
        <div className="text-xs text-sh-gray mt-1">
          {buy.daysSinceExported} days since exported · status {buy.status}
        </div>
        {/* Slice 6.2 -- sales-window context. Yellow warning when no PO ETA is set
            so the buyer knows the report includes pre-buy sales of the same frames. */}
        <div
          className={
            isFallbackWindow
              ? "mt-2 inline-block text-xs px-2 py-1 rounded bg-yellow-50 border border-yellow-200 text-yellow-900"
              : "mt-2 inline-block text-xs px-2 py-1 rounded bg-sh-stripe text-sh-navy"
          }
        >
          {salesWindow.message}
        </div>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <Kpi label="Spent" value={formatMoney(rollup.totalSpent, { whole: true })} />
        <Kpi label="Revenue" value={formatMoney(rollup.totalRevenue, { whole: true })} />
        <Kpi label="Margin" value={fmtPct(rollup.overallMargin)} />
        <Kpi
          label="Stock S/T"
          value={fmtPct(rollup.overallStockSellThrough)}
          sub={
            rollup.totalQtySpecialSold > 0 ? `+ ${rollup.totalQtySpecialSold} special` : undefined
          }
        />
      </div>

      {buy.budget && (
        <div className="text-xs text-sh-gray mb-3">
          Budget: {formatMoney(Number(buy.budget), { whole: true })}{" "}
          {overBudget && (
            <span className="text-red-700 font-semibold ml-1">
              (over by {formatMoney(rollup.totalSpent - Number(buy.budget), { whole: true })})
            </span>
          )}
        </div>
      )}

      <h3 className="font-semibold text-sh-navy mb-2 text-sm">Per-frame</h3>
      {frames.length === 0 ? (
        <p className="text-sm text-sh-gray italic">No frames to report — no drafts on this Buy.</p>
      ) : (
        <FrameTable frames={frames} formatMoney={formatMoney} />
      )}
    </section>
  );
}

function FrameTable({
  frames,
  formatMoney,
}: Readonly<{
  frames: readonly FrameRow[];
  formatMoney: (value: number | null | undefined, opts?: { whole?: boolean }) => string;
}>) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-left text-sh-gray border-b border-sh-stripe">
          <tr>
            <th className="py-2 pr-2">Frame</th>
            <th className="py-2 px-2 text-right">Ordered</th>
            <th
              className="py-2 px-2 text-right"
              title="Total units received against any PON containing a frame-mate product (stock + special)."
            >
              Received
            </th>
            <th
              className="py-2 px-2 text-right"
              title="Sales of the specific products the buyer drafted on this Buy — these came off the planned shelf."
            >
              Stock Sold
            </th>
            <th
              className="py-2 px-2 text-right"
              title="Sales of OTHER variants of the same frame (customer-spec custom orders) — informational; doesn't drive status."
            >
              Special
            </th>
            <th
              className="py-2 px-2 text-right"
              title="Stock sold ÷ ordered. Drives the status hint — special orders don't affect this."
            >
              Stock S/T
            </th>
            <th className="py-2 px-2 text-right">Revenue</th>
            <th className="py-2 px-2 text-right">Margin</th>
            <th className="py-2 pl-2 text-left">Status</th>
          </tr>
        </thead>
        <tbody>
          {frames.map((f) => (
            <FrameTableRow key={f.frameKey} frame={f} formatMoney={formatMoney} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FrameTableRow({
  frame: f,
  formatMoney,
}: Readonly<{
  frame: FrameRow;
  formatMoney: (value: number | null | undefined, opts?: { whole?: boolean }) => string;
}>) {
  const receivedTitle =
    f.qtySpecialReceived > 0
      ? `Stock: ${f.qtyStockReceived} · Special: ${f.qtySpecialReceived}`
      : undefined;
  return (
    <tr className="border-b border-sh-stripe/50">
      <td className="py-2 pr-2">
        <div className="font-mono">{f.frameLabel}</div>
        {f.draftCount > 1 && <div className="text-sh-gray text-[10px]">{f.draftCount} drafts</div>}
      </td>
      <td className="py-2 px-2 text-right">{f.qtyOrdered}</td>
      <td className="py-2 px-2 text-right" title={receivedTitle}>
        {f.qtyReceived}
      </td>
      <td className="py-2 px-2 text-right">{f.qtyStockSold}</td>
      <td
        className={`py-2 px-2 text-right ${f.qtySpecialSold > 0 ? "text-sh-blue" : "text-sh-gray"}`}
      >
        {f.qtySpecialSold}
      </td>
      <td className="py-2 px-2 text-right">{fmtPct(f.stockSellThroughRatio)}</td>
      <td className="py-2 px-2 text-right">{formatMoney(f.revenue, { whole: true })}</td>
      <td className="py-2 px-2 text-right" title={marginTitle(f)}>
        {/* Phase 6.11 -- primary number is STOCK margin (the buyer's plan in
            isolation). Combined margin shown as the small subline so special-order
            cost dilution doesn't hide stock performance. */}
        <div>{fmtPct(f.stockMarginRatio || f.marginRatio)}</div>
        {f.qtySpecialSold > 0 && (
          <div className="text-[10px] text-sh-gray">all: {fmtPct(f.marginRatio)}</div>
        )}
        {f.hasEstimatedCost && <div className="text-[10px] text-amber-600">(est)</div>}
      </td>
      <td className="py-2 pl-2">
        <span
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono ${STATUS_STYLES[f.status]}`}
        >
          <StatusIcon status={f.status} />
          {STATUS_LABELS[f.status]}
        </span>
      </td>
    </tr>
  );
}

function Kpi({ label, value, sub }: Readonly<{ label: string; value: string; sub?: string }>) {
  return (
    <div className="bg-sh-stripe/30 rounded p-3">
      <div className="text-xs text-sh-gray uppercase tracking-wide">{label}</div>
      <div className="font-semibold text-sh-navy text-base">{value}</div>
      {sub && <div className="text-[10px] text-sh-blue mt-0.5">{sub}</div>}
    </div>
  );
}

function StatusIcon({ status }: Readonly<{ status: FrameStatus }>) {
  switch (status) {
    case "underbuy":
      return <TrendingUp className="h-3 w-3" />;
    case "dead":
      return <TrendingDown className="h-3 w-3" />;
    case "soft":
      return <AlertTriangle className="h-3 w-3" />;
    case "pending":
    case "no-link":
      return <Pause className="h-3 w-3" />;
    default:
      return null;
  }
}

// ─── Linked Real POs panel ────────────────────────────────────────────
//
// Shows the empirical mapping between this Buy's drafted items and the real
// PurchaseOrder rows that came back. Joins on
// BuyerDraftItem.fulfilledProductId === PurchaseOrderItem.productId.
//
// Origin (2026-05-14): proven against Spring 2026 -- the productId join finds the
// real PONs cleanly, including 1:N where one draft PO combines multiple real
// PONs. See lib/buyerDraftRealPoLink.ts for the helper.

interface LinkedPoLine {
  productId: number | null;
  partNo: string | null;
  productName: string | null;
  orderedQuantity: number;
  unitCost: number | null;
  matchesDraft: boolean;
}

interface LinkedRealPo {
  id: number;
  poNumber: string;
  vendor: string;
  vendorId: number | null;
  orderDate: string | null;
  status: string;
  matchedLines: number;
  totalLines: number;
  matchedQty: number;
  totalQty: number;
  // Slice 6.14.1 -- line-item detail for click-to-expand.
  lines: LinkedPoLine[];
}

interface LinkedPosResponse {
  totals: {
    draftItems: number;
    draftItemsLinked: number;
    draftPos: number;
    matchedRealPos: number;
    unmatchedDraftItems: number;
  };
  realPos: LinkedRealPo[];
  draftPos: Array<{
    draftPoId: number;
    vendorName: string;
    draftItemCount: number;
    linkedRealPoNumbers: string[];
  }>;
  unmatchedDrafts: Array<{
    id: number;
    partNumber: string;
    productName: string;
    vendorName: string;
    reason: "no-link" | "not-on-any-real-po";
  }>;
  vendorMismatches: Array<{
    draftPoId: number;
    draftVendorName: string;
    realVendorName: string;
  }>;
}

function LinkedRealPosPanel({ buyId }: Readonly<{ buyId: number }>) {
  const [data, setData] = useState<LinkedPosResponse | null>(null);
  const [loading, setLoading] = useState(true);
  // Slice 6.14.1 -- expand-on-click for line items.
  const [expandedPoIds, setExpandedPoIds] = useState<Set<number>>(new Set());

  const toggleExpanded = useCallback((poId: number) => {
    setExpandedPoIds((prev) => {
      const next = new Set(prev);
      if (next.has(poId)) next.delete(poId);
      else next.add(poId);
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await axios.get<LinkedPosResponse>(
        `/api/admin/buyer-drafts/buys/${buyId}/linked-pos`,
      );
      setData(res.data);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to load linked POs"));
    } finally {
      setLoading(false);
    }
  }, [buyId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <section className="mt-8 bg-white border border-sh-stripe rounded-lg p-6">
        <header className="mb-3">
          <h2 className="font-serif text-xl text-sh-navy">Linked Real Purchase Orders</h2>
        </header>
        <div className="flex items-center gap-2 text-sm text-sh-gray">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      </section>
    );
  }
  if (!data) return null;

  const hasMismatches = data.vendorMismatches.length > 0;
  const hasUnmatched = data.unmatchedDrafts.length > 0;

  return (
    <section className="mt-8 bg-white border border-sh-stripe rounded-lg p-6">
      <header className="mb-4">
        <h2 className="font-serif text-xl text-sh-navy">Linked Real Purchase Orders</h2>
        <p className="text-sm text-sh-gray mt-1 max-w-3xl">
          Real purchase orders that contain the items drafted under this Buy. Matched by linked
          catalog Product (productId join, not barcode). One draft PO can span multiple real POs
          when the buyer combined them for planning.
        </p>
      </header>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6">
        <SmallStat label="Draft items" value={String(data.totals.draftItems)} />
        <SmallStat
          label="Linked to catalog"
          value={`${data.totals.draftItemsLinked} / ${data.totals.draftItems}`}
        />
        <SmallStat label="Draft POs" value={String(data.totals.draftPos)} />
        <SmallStat label="Matched real POs" value={String(data.totals.matchedRealPos)} />
        <SmallStat
          label="Unmatched drafts"
          value={String(data.totals.unmatchedDraftItems)}
          accent={hasUnmatched ? "warn" : "ok"}
        />
      </div>

      {hasMismatches && <VendorMismatchList mismatches={data.vendorMismatches} />}

      <RealPosTable
        realPos={data.realPos}
        expandedPoIds={expandedPoIds}
        onToggle={toggleExpanded}
      />

      {data.draftPos.length > 0 && <DraftPosTable draftPos={data.draftPos} />}

      {hasUnmatched && <UnmatchedDraftsDetails drafts={data.unmatchedDrafts} />}
    </section>
  );
}

function VendorMismatchList({
  mismatches,
}: Readonly<{ mismatches: LinkedPosResponse["vendorMismatches"] }>) {
  return (
    <div className="mb-6 bg-amber-50 border border-amber-200 rounded p-3 text-xs">
      <div className="flex items-center gap-1.5 font-semibold text-amber-900 mb-1">
        <CircleAlert className="h-4 w-4" /> Vendor mismatches
      </div>
      <ul className="space-y-0.5 text-amber-900">
        {mismatches.map((m) => (
          <li key={`${m.draftPoId}-${m.realVendorName}`}>
            Draft PO #{m.draftPoId}: drafted as <strong>{m.draftVendorName}</strong> but the linked
            Product belongs to <strong>{m.realVendorName}</strong>.
          </li>
        ))}
      </ul>
    </div>
  );
}

function RealPosTable({
  realPos,
  expandedPoIds,
  onToggle,
}: Readonly<{
  realPos: readonly LinkedRealPo[];
  expandedPoIds: ReadonlySet<number>;
  onToggle: (poId: number) => void;
}>) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase text-sh-gray tracking-wide">
          <tr className="border-b border-sh-stripe">
            <th className="py-2 px-3 w-6" aria-label="Expand" />
            <th className="py-2 px-3">PON</th>
            <th className="py-2 px-3">Vendor</th>
            <th className="py-2 px-3">Order date</th>
            <th className="py-2 px-3">Status</th>
            <th className="py-2 px-3 text-right">Matched lines</th>
            <th className="py-2 px-3 text-right">Matched qty</th>
          </tr>
        </thead>
        <tbody>
          {realPos.length === 0 ? (
            <tr>
              <td colSpan={7} className="py-4 px-3 text-sh-gray text-sm italic">
                No real purchase orders cover this Buy yet. If items were exported and the daily
                import has run, drafts should match here.
              </td>
            </tr>
          ) : (
            realPos.map((po) => (
              <RealPoRows
                key={po.id}
                po={po}
                isOpen={expandedPoIds.has(po.id)}
                onToggle={onToggle}
              />
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function RealPoRows({
  po,
  isOpen,
  onToggle,
}: Readonly<{ po: LinkedRealPo; isOpen: boolean; onToggle: (poId: number) => void }>) {
  return (
    <>
      <tr
        onClick={() => onToggle(po.id)}
        className="border-b border-sh-stripe/40 last:border-0 cursor-pointer hover:bg-sh-stripe/40"
        aria-expanded={isOpen}
      >
        <td className="py-2 px-3 text-sh-gray text-xs">{isOpen ? "▾" : "▸"}</td>
        <td className="py-2 px-3 font-semibold text-sh-navy">{po.poNumber}</td>
        <td className="py-2 px-3 text-sh-gray">{po.vendor}</td>
        <td className="py-2 px-3 text-xs text-sh-gray">{formatPoDate(po.orderDate)}</td>
        <td className="py-2 px-3 text-xs">
          <RealPoStatusBadge status={po.status} />
        </td>
        <td className="py-2 px-3 text-right tabular-nums">
          {po.matchedLines} / {po.totalLines}
        </td>
        <td className="py-2 px-3 text-right tabular-nums">
          {po.matchedQty} / {po.totalQty}
        </td>
      </tr>
      {isOpen && (
        <tr className="border-b border-sh-stripe/40">
          <td colSpan={7} className="py-3 px-6 bg-sh-stripe/20">
            <RealPoLines po={po} />
          </td>
        </tr>
      )}
    </>
  );
}

function RealPoLines({ po }: Readonly<{ po: LinkedRealPo }>) {
  const formatMoney = useMoneyFormatter();
  if (po.lines.length === 0) {
    return <div className="text-xs italic text-sh-gray">No line items on this PO.</div>;
  }
  return (
    <table className="w-full text-xs">
      <thead className="text-left uppercase text-sh-gray">
        <tr>
          <th className="py-1 pr-3">In plan?</th>
          <th className="py-1 pr-3">Part #</th>
          <th className="py-1 pr-3">Name</th>
          <th className="py-1 pr-3 text-right">Qty</th>
          <th className="py-1 pr-3 text-right">Unit cost</th>
        </tr>
      </thead>
      <tbody>
        {po.lines.map((line, idx) => (
          <tr
            key={`${po.id}-line-${line.productId ?? "null"}-${idx}`}
            className="border-t border-sh-stripe/30"
          >
            <td className="py-1 pr-3">
              <PlanBadge inPlan={line.matchesDraft} />
            </td>
            <td className="py-1 pr-3 font-mono text-sh-navy">{line.partNo ?? "—"}</td>
            <td className="py-1 pr-3 text-sh-gray">{line.productName ?? "—"}</td>
            <td className="py-1 pr-3 text-right tabular-nums">{line.orderedQuantity}</td>
            <td className="py-1 pr-3 text-right tabular-nums">
              {line.unitCost == null ? "—" : formatMoney(line.unitCost)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PlanBadge({ inPlan }: Readonly<{ inPlan: boolean }>) {
  if (inPlan) {
    return (
      <span className="font-mono px-1.5 py-0.5 rounded bg-sh-blue/15 text-sh-blue text-[10px]">
        STOCK
      </span>
    );
  }
  return (
    <span className="font-mono px-1.5 py-0.5 rounded bg-sh-stripe text-sh-gray text-[10px]">
      other
    </span>
  );
}

function DraftPosTable({ draftPos }: Readonly<{ draftPos: LinkedPosResponse["draftPos"] }>) {
  return (
    <div className="mt-6">
      <h3 className="font-serif text-sm uppercase tracking-wide text-sh-gray mb-2">By draft PO</h3>
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase text-sh-gray tracking-wide">
          <tr className="border-b border-sh-stripe">
            <th className="py-2 px-3">Draft PO</th>
            <th className="py-2 px-3">Vendor</th>
            <th className="py-2 px-3 text-right">Items</th>
            <th className="py-2 px-3">Linked PONs</th>
          </tr>
        </thead>
        <tbody>
          {draftPos.map((dp) => (
            <tr key={dp.draftPoId} className="border-b border-sh-stripe/40 last:border-0">
              <td className="py-2 px-3 text-sh-gray">#{dp.draftPoId}</td>
              <td className="py-2 px-3">{dp.vendorName}</td>
              <td className="py-2 px-3 text-right tabular-nums">{dp.draftItemCount}</td>
              <td className="py-2 px-3 text-xs">
                {dp.linkedRealPoNumbers.length === 0 ? (
                  <span className="italic text-sh-gray">—</span>
                ) : (
                  dp.linkedRealPoNumbers.join(", ")
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UnmatchedDraftsDetails({
  drafts,
}: Readonly<{ drafts: LinkedPosResponse["unmatchedDrafts"] }>) {
  return (
    <details className="mt-6">
      <summary className="cursor-pointer font-semibold text-sm text-sh-navy min-h-[44px] flex items-center">
        Unmatched drafts ({drafts.length})
      </summary>
      <table className="w-full text-sm mt-2">
        <thead className="text-left text-xs uppercase text-sh-gray tracking-wide">
          <tr className="border-b border-sh-stripe">
            <th className="py-2 px-3">Part #</th>
            <th className="py-2 px-3">Product</th>
            <th className="py-2 px-3">Vendor</th>
            <th className="py-2 px-3">Reason</th>
          </tr>
        </thead>
        <tbody>
          {drafts.map((d) => (
            <tr key={d.id} className="border-b border-sh-stripe/40 last:border-0">
              <td className="py-2 px-3 font-mono text-xs">{d.partNumber}</td>
              <td className="py-2 px-3">{d.productName}</td>
              <td className="py-2 px-3 text-sh-gray">{d.vendorName}</td>
              <td className="py-2 px-3 text-xs">
                {d.reason === "no-link"
                  ? "Not linked to a catalog Product"
                  : "Linked, but not on any real PO yet"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function SmallStat({
  label,
  value,
  accent,
}: Readonly<{ label: string; value: string; accent?: "ok" | "warn" }>) {
  const color = accent === "warn" ? "text-amber-700" : "text-sh-navy";
  return (
    <div className="border border-sh-stripe rounded p-3">
      <div className="text-xs uppercase tracking-wide text-sh-gray">{label}</div>
      <div className={`font-serif text-2xl ${color}`}>{value}</div>
    </div>
  );
}

function statusBadgeStyles(status: string): string {
  if (status === "RECEIVED_FULL") return "bg-emerald-100 text-emerald-700";
  if (status === "RECEIVED_PARTIAL") return "bg-amber-100 text-amber-700";
  if (status === "CONFIRMED" || status === "SUBMITTED") return "bg-sh-blue/15 text-sh-blue";
  return "bg-sh-stripe text-sh-gray";
}

function RealPoStatusBadge({ status }: Readonly<{ status: string }>) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-2 py-0.5 ${statusBadgeStyles(status)}`}
    >
      {status === "RECEIVED_FULL" && <PackageCheck className="h-3 w-3" />}
      {status}
    </span>
  );
}
