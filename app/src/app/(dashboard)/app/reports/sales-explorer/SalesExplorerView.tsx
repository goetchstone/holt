"use client";

// /app/src/app/(dashboard)/app/reports/sales-explorer/SalesExplorerView.tsx
//
// Client view for the Sales Explorer report: a two-period comparative sales
// pivot the manager can switch between Store / Department / Category /
// Vendor, expand into a drill-down tree, and drill a leaf node further into
// product-level rows for either period. Filter-driven via tRPC useQuery (runs
// after "Run Report", same committed-filters pattern as Comparative Sales /
// Gross Margin); the leaf drilldown fetches on demand via api.useUtils().
// MANAGER/ADMIN; the page gates server-side.

import { Fragment, useState } from "react";
import Link from "next/link";
import { Loader2, ArrowUp, ArrowDown, ChevronRight, ChevronDown } from "lucide-react";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { formatMarginPct } from "@/lib/marginMath";
import MultiSelectDropdown from "@/components/form/MultiSelectDropdown";
import { api } from "@/lib/trpc/client";
import {
  SALES_EXPLORER_PIVOTS,
  type SalesExplorerPivot,
  type SalesExplorerNode,
  type PeriodAgg,
} from "@/lib/reports/salesExplorerPivot";

const PIVOT_LABELS: Record<SalesExplorerPivot, string> = {
  store: "Store",
  department: "Department",
  category: "Category",
  vendor: "Vendor",
};

const intFmt = new Intl.NumberFormat("en-US");

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}
function firstOfMonthStr(d: string): string {
  return d.slice(0, 8) + "01";
}
function lastYearStr(d: string): string {
  const date = new Date(d);
  date.setFullYear(date.getFullYear() - 1);
  return date.toISOString().slice(0, 10);
}

function toOptions(names: readonly string[]) {
  return names.map((n) => ({ value: n, label: n }));
}

/** Expand/collapse chevron for a tree row, or a spacer for a leaf. */
function RowChevron({ hasChildren, isOpen }: Readonly<{ hasChildren: boolean; isOpen: boolean }>) {
  if (!hasChildren) return <span className="inline-block w-4 shrink-0" />;
  return isOpen ? (
    <ChevronDown className="h-4 w-4 shrink-0 text-sh-gold" />
  ) : (
    <ChevronRight className="h-4 w-4 shrink-0 text-sh-gold" />
  );
}

/** Flatten the tree into the rows currently visible given the expanded set. */
function flattenVisible(
  nodes: SalesExplorerNode[],
  expanded: Set<string>,
  depth = 0,
  out: Array<{ node: SalesExplorerNode; depth: number }> = [],
): Array<{ node: SalesExplorerNode; depth: number }> {
  for (const node of nodes) {
    out.push({ node, depth });
    if (node.children.length > 0 && expanded.has(node.id)) {
      flattenVisible(node.children, expanded, depth + 1, out);
    }
  }
  return out;
}

export function SalesExplorerView() {
  const money = useMoneyFormatter();
  const fmt = (v: number) => money(v, { whole: true });
  const utils = api.useUtils();

  const now = todayStr();
  const [p1Start, setP1Start] = useState(firstOfMonthStr(now));
  const [p1End, setP1End] = useState(now);
  const [p2Start, setP2Start] = useState(lastYearStr(firstOfMonthStr(now)));
  const [p2End, setP2End] = useState(lastYearStr(now));
  const [pivot, setPivot] = useState<SalesExplorerPivot>("department");

  const [stores, setStores] = useState<string[]>([]);
  const [departments, setDepartments] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [vendors, setVendors] = useState<string[]>([]);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Leaf-node product drilldown: key = `${nodeId}::${period}`.
  const [openDrill, setOpenDrill] = useState<string | null>(null);
  const [drillPeriod, setDrillPeriod] = useState<1 | 2>(1);
  const [drillItems, setDrillItems] = useState<Record<string, unknown[]>>({});
  const [drillLoading, setDrillLoading] = useState<string | null>(null);

  type Committed = {
    p1Start: string;
    p1End: string;
    p2Start: string;
    p2End: string;
    pivot: SalesExplorerPivot;
    stores: string[];
    departments: string[];
    categories: string[];
    vendors: string[];
  };
  const [committed, setCommitted] = useState<Committed | null>(null);

  const query = api.reports.salesExplorer.useQuery(
    committed ?? { p1Start, p1End, p2Start, p2End, pivot },
    { enabled: committed !== null },
  );
  const loading = query.isFetching;
  const data = query.data;

  function run() {
    setCommitted({
      p1Start,
      p1End,
      p2Start,
      p2End,
      pivot,
      stores,
      departments,
      categories,
      vendors,
    });
    setExpanded(new Set());
    setOpenDrill(null);
  }

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function toggleDrill(node: SalesExplorerNode, period: 1 | 2) {
    const key = `${node.id}::${period}`;
    if (openDrill === key) {
      setOpenDrill(null);
      return;
    }
    setOpenDrill(key);
    setDrillPeriod(period);
    if (drillItems[key] || !committed) return;
    setDrillLoading(key);
    try {
      const rows = await utils.reports.salesExplorerItems.fetch({
        pivot: committed.pivot,
        nodeId: node.id,
        period,
        p1Start: committed.p1Start,
        p1End: committed.p1End,
        p2Start: committed.p2Start,
        p2End: committed.p2End,
      });
      setDrillItems((prev) => ({ ...prev, [key]: rows }));
    } finally {
      setDrillLoading(null);
    }
  }

  function VarianceBadge({ value, pct }: Readonly<{ value: number; pct: number | null }>) {
    if (value === 0 && pct === null) return <span className="text-sh-gray">--</span>;
    const isPositive = value >= 0;
    return (
      <span
        className={`flex items-center justify-end gap-1 ${isPositive ? "text-green-700" : "text-red-700"}`}
      >
        {isPositive ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
        {fmt(Math.abs(value))}
        {pct !== null && <span className="ml-1 text-xs">({Math.abs(pct * 100).toFixed(1)}%)</span>}
      </span>
    );
  }

  function NodeCell({
    node,
    period,
    agg,
    marginPct,
    conversion,
  }: Readonly<{
    node: SalesExplorerNode;
    period: 1 | 2;
    agg: PeriodAgg;
    marginPct: number | null;
    conversion?: number | null;
  }>) {
    const isLeaf = node.children.length === 0;
    const sub: string[] = [`${intFmt.format(agg.itemCount)} items`];
    if (agg.orderCount !== undefined) {
      sub.push(`${intFmt.format(agg.orderCount)} ord`);
      sub.push(agg.visitors ? `${intFmt.format(agg.visitors)} vis` : "no traffic");
    }
    const kpis = [
      marginPct !== null ? `${formatMarginPct(marginPct)} mgn` : null,
      conversion != null ? `${(conversion * 100).toFixed(1)}% conv` : null,
    ].filter(Boolean);
    return (
      <button
        type="button"
        disabled={!isLeaf}
        onClick={() => isLeaf && toggleDrill(node, period)}
        className={`flex w-full flex-col items-end leading-tight ${isLeaf ? "cursor-pointer hover:underline" : "cursor-default"}`}
        title={isLeaf ? "View product-level rows for this period" : undefined}
      >
        <span className="text-sh-black">{fmt(agg.netSales)}</span>
        <span className="text-xs text-sh-gray">{sub.join(" · ")}</span>
        {kpis.length > 0 && <span className="text-xs text-sh-gold">{kpis.join(" · ")}</span>}
      </button>
    );
  }

  const rows = data ? flattenVisible(data.tree, expanded) : [];
  const showConversion = data ? !data.trafficDecoupled : true;

  return (
    <div className="space-y-6 font-serif">
      <nav className="text-sm text-sh-gray">
        <Link href="/app/reports" className="hover:underline">
          Reports
        </Link>
        <span className="mx-2">/</span>
        <span className="text-sh-black">Sales Explorer</span>
      </nav>
      <h1 className="text-2xl font-semibold text-sh-navy">Sales Explorer</h1>
      <p className="text-sm text-sh-gray">
        Compare two periods across Store, Department, Category, and Vendor. Expand any row to drill
        in; click a leaf row&apos;s dollar figure to see the product-level line items behind it.
        Cancelled lines are excluded; returns net out against their original sale.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-sh-gray">Pivot by</span>
        {SALES_EXPLORER_PIVOTS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPivot(p)}
            className={`min-h-[44px] rounded border px-3 text-sm ${
              pivot === p
                ? "border-sh-navy bg-sh-navy text-white"
                : "border-gray-300 bg-white text-sh-navy hover:border-sh-gold"
            }`}
          >
            {PIVOT_LABELS[p]}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div>
          <label htmlFor="se-p1-start" className="mb-1 block text-xs font-medium text-sh-gray">
            Current Start
          </label>
          <input
            id="se-p1-start"
            type="date"
            value={p1Start}
            onChange={(e) => setP1Start(e.target.value)}
            className="min-h-[44px] rounded border border-gray-300 px-3 text-sm"
          />
        </div>
        <div>
          <label htmlFor="se-p1-end" className="mb-1 block text-xs font-medium text-sh-gray">
            Current End
          </label>
          <input
            id="se-p1-end"
            type="date"
            value={p1End}
            onChange={(e) => setP1End(e.target.value)}
            className="min-h-[44px] rounded border border-gray-300 px-3 text-sm"
          />
        </div>
        <div className="self-center px-2 text-sm font-semibold text-sh-gray">vs</div>
        <div>
          <label htmlFor="se-p2-start" className="mb-1 block text-xs font-medium text-sh-gray">
            Compare Start
          </label>
          <input
            id="se-p2-start"
            type="date"
            value={p2Start}
            onChange={(e) => setP2Start(e.target.value)}
            className="min-h-[44px] rounded border border-gray-300 px-3 text-sm"
          />
        </div>
        <div>
          <label htmlFor="se-p2-end" className="mb-1 block text-xs font-medium text-sh-gray">
            Compare End
          </label>
          <input
            id="se-p2-end"
            type="date"
            value={p2End}
            onChange={(e) => setP2End(e.target.value)}
            className="min-h-[44px] rounded border border-gray-300 px-3 text-sm"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <MultiSelectDropdown
          label="Stores"
          emptyLabel="All Stores"
          options={toOptions(data?.options.stores ?? [])}
          selected={stores}
          onChange={setStores}
        />
        <MultiSelectDropdown
          label="Departments"
          emptyLabel="All Departments"
          options={toOptions(data?.options.departments ?? [])}
          selected={departments}
          onChange={setDepartments}
        />
        <MultiSelectDropdown
          label="Categories"
          emptyLabel="All Categories"
          options={toOptions(data?.options.categories ?? [])}
          selected={categories}
          onChange={setCategories}
        />
        <MultiSelectDropdown
          label="Vendors"
          emptyLabel="All Vendors"
          options={toOptions(data?.options.vendors ?? [])}
          selected={vendors}
          onChange={setVendors}
        />
        <button
          type="button"
          onClick={run}
          disabled={loading}
          className="min-h-[44px] rounded-lg bg-sh-navy px-5 py-2 text-sm font-semibold text-white transition hover:bg-sh-blue disabled:opacity-50"
        >
          {loading ? "Loading..." : "Run Report"}
        </button>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-sh-gold" />
        </div>
      )}

      {data && !loading && (
        <>
          <div className="overflow-hidden rounded-lg border border-sh-gray/20 bg-white shadow-md">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-sh-gray/20 bg-sh-linen">
                  <th className="px-4 py-3 text-left font-semibold text-sh-gray">
                    {PIVOT_LABELS[data.pivot]}
                  </th>
                  <th className="px-4 py-3 text-right font-semibold text-sh-gray">
                    {data.period1Label}
                  </th>
                  <th className="px-4 py-3 text-right font-semibold text-sh-gray">
                    {data.period2Label}
                  </th>
                  <th className="px-4 py-3 text-right font-semibold text-sh-gray">Variance</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ node, depth }) => {
                  const hasChildren = node.children.length > 0;
                  const isOpen = expanded.has(node.id);
                  return (
                    <Fragment key={node.id}>
                      <tr className="border-b border-sh-gray/10 hover:bg-sh-stripe">
                        <td className="px-4 py-2 align-top">
                          <button
                            type="button"
                            onClick={() => hasChildren && toggle(node.id)}
                            className="flex items-center gap-1 text-left text-sh-navy"
                            style={{ paddingLeft: `${depth * 18}px` }}
                          >
                            <RowChevron hasChildren={hasChildren} isOpen={isOpen} />
                            <span className={depth === 0 ? "font-semibold" : ""}>{node.name}</span>
                          </button>
                        </td>
                        <td className="px-4 py-2 text-right align-top">
                          <NodeCell
                            node={node}
                            period={1}
                            agg={node.period1}
                            marginPct={node.marginPct1}
                            conversion={showConversion ? node.conversion1 : undefined}
                          />
                        </td>
                        <td className="px-4 py-2 text-right align-top">
                          <NodeCell
                            node={node}
                            period={2}
                            agg={node.period2}
                            marginPct={node.marginPct2}
                            conversion={showConversion ? node.conversion2 : undefined}
                          />
                        </td>
                        <td className="px-4 py-2 text-right align-top">
                          <VarianceBadge value={node.variance} pct={node.variancePct} />
                        </td>
                      </tr>
                      {node.children.length === 0 &&
                        (openDrill === `${node.id}::1` || openDrill === `${node.id}::2`) && (
                          <tr
                            key={`${node.id}-drill`}
                            className="border-b border-sh-gray/10 bg-sh-linen/40"
                          >
                            <td colSpan={4} className="px-4 py-3">
                              <DrillTable
                                periodLabel={
                                  drillPeriod === 1 ? data.period1Label : data.period2Label
                                }
                                loading={drillLoading === `${node.id}::${drillPeriod}`}
                                items={drillItems[`${node.id}::${drillPeriod}`]}
                                fmt={fmt}
                              />
                            </td>
                          </tr>
                        )}
                    </Fragment>
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-sh-gray">
                      No sales for the selected periods and filters.
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-sh-navy bg-sh-linen">
                  <td className="px-4 py-3 align-top font-semibold text-sh-navy">Total</td>
                  <td className="px-4 py-3 text-right align-top font-semibold">
                    {fmt(data.totals.period1.netSales)}
                  </td>
                  <td className="px-4 py-3 text-right align-top font-semibold">
                    {fmt(data.totals.period2.netSales)}
                  </td>
                  <td className="px-4 py-3 text-right align-top font-semibold">
                    <VarianceBadge value={data.totals.variance} pct={data.totals.variancePct} />
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {data.pivot === "store" && data.storeTraffic.length > 0 && (
            <div className="overflow-hidden rounded-lg border border-sh-gray/20 bg-white shadow-md">
              <div className="border-b border-sh-gray/20 bg-sh-linen px-4 py-2">
                <h2 className="font-serif text-sm font-semibold text-sh-navy">Store Traffic</h2>
                <p className="text-xs text-sh-gray">
                  Axper door-counter visitors. Conversion = orders ÷ visitors.
                  {data.trafficDecoupled &&
                    " A dept/category/vendor filter is active, so conversion reflects filtered sales against total store traffic — read it as a trend, not an exact rate."}
                </p>
              </div>
              <table className="w-full font-serif text-sm">
                <thead>
                  <tr className="border-b border-sh-gray/20 text-xs text-sh-gray">
                    <th className="px-4 py-2 text-left font-semibold">Store</th>
                    <th className="px-4 py-2 text-right font-semibold">Visitors (cur / cmp)</th>
                    <th className="px-4 py-2 text-right font-semibold">Orders (cur / cmp)</th>
                    <th className="px-4 py-2 text-right font-semibold">Conversion (cur / cmp)</th>
                  </tr>
                </thead>
                <tbody>
                  {data.storeTraffic.map((row) => (
                    <tr key={row.store} className="border-b border-sh-gray/10">
                      <td className="px-4 py-2 font-semibold text-sh-navy">{row.store}</td>
                      <td className="px-4 py-2 text-right">
                        {intFmt.format(row.visitors1)} / {intFmt.format(row.visitors2)}
                      </td>
                      <td className="px-4 py-2 text-right">
                        {intFmt.format(row.orderCount1)} / {intFmt.format(row.orderCount2)}
                      </td>
                      <td className="px-4 py-2 text-right">
                        {row.conversion1 === null ? "--" : `${(row.conversion1 * 100).toFixed(1)}%`}
                        {" / "}
                        {row.conversion2 === null ? "--" : `${(row.conversion2 * 100).toFixed(1)}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {committed === null && !loading && (
        <p className="py-16 text-center text-sh-gray">Pick two periods and click Run Report</p>
      )}
    </div>
  );
}

/** Product-level line items behind one leaf node's dollar figure, for one period. */
function DrillTable({
  periodLabel,
  loading,
  items,
  fmt,
}: Readonly<{
  periodLabel: string;
  loading: boolean;
  items: unknown[] | undefined;
  fmt: (v: number) => string;
}>) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-sh-gray">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading items for {periodLabel}...
      </div>
    );
  }
  const rows = (items ?? []) as Array<{
    id: number;
    orderno: string;
    orderDate: string | null;
    customerName: string | null;
    productName: string | null;
    partNo: string | null;
    netPrice: number;
    orderedQuantity: number;
  }>;
  if (rows.length === 0) {
    return <p className="text-sm text-sh-gray">No product-level rows for {periodLabel}.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <p className="mb-2 text-xs font-semibold text-sh-gray">Line items — {periodLabel}</p>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-sh-gray">
            <th className="pr-3 pb-1">Order</th>
            <th className="pr-3 pb-1">Date</th>
            <th className="pr-3 pb-1">Customer</th>
            <th className="pr-3 pb-1">Part #</th>
            <th className="pr-3 pb-1">Product</th>
            <th className="pr-3 pb-1 text-right">Qty</th>
            <th className="pr-3 pb-1 text-right">Net</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 500).map((it) => (
            <tr key={it.id} className="border-t border-sh-gray/10">
              <td className="py-1 pr-3">{it.orderno}</td>
              <td className="py-1 pr-3">{it.orderDate ? it.orderDate.slice(0, 10) : "--"}</td>
              <td className="py-1 pr-3">{it.customerName ?? "--"}</td>
              <td className="py-1 pr-3">{it.partNo ?? "--"}</td>
              <td className="py-1 pr-3">{it.productName ?? "--"}</td>
              <td className="py-1 pr-3 text-right">{it.orderedQuantity}</td>
              <td className="py-1 pr-3 text-right">{fmt(it.netPrice)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
