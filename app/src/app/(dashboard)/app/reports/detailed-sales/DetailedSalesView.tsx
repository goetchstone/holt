"use client";

// /app/src/app/(dashboard)/app/reports/detailed-sales/DetailedSalesView.tsx
//
// Detailed Sales (Sales by Department) — App Router + tRPC client view. Ported
// verbatim from the Pages version minus MainLayout.
//
// UX:
//   - filter bar: date range + store/department/vendor multi-selects + Run
//     Report + Export CSV + Relink Line Items
//   - summary loaded on "Run Report" (tRPC utils.fetch, imperative — matches the
//     legacy button-driven flow), then filtered/pivoted entirely client-side
//   - store summary table + grand total
//   - two pivots: By Department (store → dept → line items) and By Supplier
//     (vendor → dept → category → line items)
//   - per-cell drilldown fetched imperatively + cached
//   - inline edit modal (relink / create product) stays REST via axios
//
// The summary + drilldown data + math live in src/lib/reports/detailedSales.ts.
// CSV export stays a REST download (the export route is untouched during the
// migration); the edit/lookup endpoints (/api/products, /api/products/quick-
// create, /api/sales/orders/*, /api/admin/relink-line-items) stay REST too.

import { Fragment, useCallback, useState, useMemo } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import Link from "next/link";
import { format, startOfDay, subDays } from "date-fns";
import DateRangeFilter from "@/components/form/DateRangeFilter";
import MultiSelectDropdown from "@/components/form/MultiSelectDropdown";
import TaxonomyPicker from "@/components/form/TaxonomyPicker";
import { Button } from "@/components/ui/button";
import { parseLocalDate } from "@/lib/dateUtils";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { api } from "@/lib/trpc/client";
import type { DetailedSalesRow, DetailedSalesItem } from "@/lib/reports/detailedSales";

// Drilldown row shape rendered in the view. The lib returns more fields than
// the legacy page consumed; the page-local type pins exactly what's read so the
// edit modal's optimistic-update spread stays type-safe.
type SalesRow = DetailedSalesRow;
type DrilldownItem = DetailedSalesItem;

type Pivot = "department" | "vendor";

interface ProductSearchHit {
  id: number;
  name: string;
  productNumber: string;
  departmentName?: string | null;
  categoryName?: string | null;
  vendorName?: string | null;
}

/**
 * Body of the expanded store-row drilldown. Three states (loading,
 * empty, has-items) flattened with early returns rather than nested
 * ternary so Sonar S3358 is satisfied. Lives at module scope so the
 * parent's render function stays scannable.
 */
function StoreDrilldownContent({
  isLoading,
  items,
}: Readonly<{
  isLoading: boolean;
  items: DrilldownItem[] | undefined;
}>) {
  const fmt = useMoneyFormatter();
  if (isLoading) {
    return <p className="text-sm text-sh-gray">Loading line items…</p>;
  }
  if (!items || items.length === 0) {
    return <p className="text-sm text-sh-gray">No line items in this store.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-sh-gray border-b border-sh-gray/20">
            <th className="py-1.5 pr-3">Order</th>
            <th className="py-1.5 pr-3">Customer</th>
            <th className="py-1.5 pr-3">Date</th>
            <th className="py-1.5 pr-3">Dept</th>
            <th className="py-1.5 pr-3">Part #</th>
            <th className="py-1.5 pr-3">Item</th>
            <th className="py-1.5 pr-3 text-right">Net</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr key={it.id} className="border-b border-sh-gray/10">
              <td className="py-1.5 pr-3">
                <Link
                  href={`/app/sales/orders/${it.orderId}`}
                  className="text-sh-blue hover:underline"
                >
                  {it.orderno}
                </Link>
              </td>
              <td className="py-1.5 pr-3 text-sh-black">{it.customerName ?? "—"}</td>
              <td className="py-1.5 pr-3 text-sh-gray">
                {it.orderDate ? parseLocalDate(it.orderDate).toLocaleDateString() : "—"}
              </td>
              <td className="py-1.5 pr-3 text-sh-gray">{it.departmentName ?? "Uncategorized"}</td>
              <td className="py-1.5 pr-3 font-mono text-[11px]">{it.partNo ?? ""}</td>
              <td className="py-1.5 pr-3 text-sh-black max-w-[260px] truncate">
                {it.productName ?? "—"}
              </td>
              <td className="py-1.5 pr-3 text-right">{fmt(it.netPrice)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {items.length >= 500 && (
        <p className="text-xs text-sh-gray mt-2">
          Showing first 500 items. Narrow the date range or department filter to see others.
        </p>
      )}
    </div>
  );
}

// ── Supplier pivot view ─────────────────────────────────────────────────────
//
// Renders the vendor → department → category → line items rollup. Lives at
// module scope so the parent's render stays scannable (S2004 / S3776).
// All state lives in the parent — this component is presentational + click
// handlers passed down.

interface VendorBreakdownEntry {
  departments: Map<
    string,
    {
      categories: Map<string, { netSales: number; taxCollected: number; itemCount: number }>;
      netSales: number;
      taxCollected: number;
      itemCount: number;
    }
  >;
  netSales: number;
  taxCollected: number;
  itemCount: number;
}

function SupplierPivotView({
  vendorBreakdown,
  expandedKey,
  setExpandedKey,
  itemsByKey,
  itemsLoading,
  onCategoryDrill,
  onEdit,
}: Readonly<{
  vendorBreakdown: Map<string, VendorBreakdownEntry>;
  expandedKey: string | null;
  setExpandedKey: (k: string | null) => void;
  itemsByKey: Record<string, DrilldownItem[]>;
  itemsLoading: string | null;
  onCategoryDrill: (vendor: string, dept: string, cat: string) => void;
  onEdit: (item: DrilldownItem) => void;
}>) {
  const fmt = useMoneyFormatter();
  const vendorRows = Array.from(vendorBreakdown.entries())
    .map(([vendor, entry]) => ({
      vendor,
      ...entry,
    }))
    .sort((a, b) => b.netSales - a.netSales);

  if (vendorRows.length === 0) {
    return <p className="text-sh-gray text-center py-8">No vendor data to pivot.</p>;
  }

  return (
    <div className="space-y-3">
      {vendorRows.map((vRow) => {
        const vKey = `vendor:${vRow.vendor}`;
        const vExpanded = expandedKey === vKey || expandedKey?.startsWith(`${vKey}|`);
        return (
          <div
            key={vRow.vendor}
            className="bg-white border border-sh-gray/20 rounded-lg shadow-sm overflow-hidden"
          >
            <button
              type="button"
              onClick={() => setExpandedKey(vExpanded ? null : vKey)}
              className={`w-full text-left bg-sh-linen px-3 py-2 border-b border-sh-gray/20 transition flex items-center justify-between ${
                vExpanded ? "bg-sh-linen/80" : "hover:bg-sh-linen/60"
              }`}
            >
              <h3 className="text-sm font-semibold text-sh-blue flex items-center gap-2">
                <span className="inline-block w-3 text-sh-gray">{vExpanded ? "▾" : "▸"}</span>
                {vRow.vendor}
              </h3>
              <span className="text-xs text-sh-gray">
                {vRow.itemCount.toLocaleString()} item{vRow.itemCount === 1 ? "" : "s"} ·{" "}
                <span className="font-semibold text-sh-black">{fmt(vRow.netSales)}</span>
              </span>
            </button>
            {vExpanded && (
              <SupplierDeptTable
                vendor={vRow.vendor}
                departments={vRow.departments}
                expandedKey={expandedKey}
                setExpandedKey={setExpandedKey}
                itemsByKey={itemsByKey}
                itemsLoading={itemsLoading}
                onCategoryDrill={onCategoryDrill}
                onEdit={onEdit}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function SupplierDeptTable({
  vendor,
  departments,
  expandedKey,
  setExpandedKey,
  itemsByKey,
  itemsLoading,
  onCategoryDrill,
  onEdit,
}: Readonly<{
  vendor: string;
  departments: VendorBreakdownEntry["departments"];
  expandedKey: string | null;
  setExpandedKey: (k: string | null) => void;
  itemsByKey: Record<string, DrilldownItem[]>;
  itemsLoading: string | null;
  onCategoryDrill: (vendor: string, dept: string, cat: string) => void;
  onEdit: (item: DrilldownItem) => void;
}>) {
  const fmt = useMoneyFormatter();
  const deptRows = Array.from(departments.entries())
    .map(([dept, entry]) => ({ dept, ...entry }))
    .sort((a, b) => b.netSales - a.netSales);

  return (
    <div className="px-3 py-2">
      {deptRows.map((dRow) => {
        const dKey = `vendor:${vendor}|${dRow.dept}`;
        const dExpanded = expandedKey === dKey || expandedKey?.startsWith(`${dKey}|`);
        return (
          <div key={dRow.dept} className="border-b border-sh-gray/10 last:border-b-0">
            <button
              type="button"
              onClick={() => setExpandedKey(dExpanded ? null : dKey)}
              className="w-full flex items-center justify-between py-2 px-2 text-sm hover:bg-sh-stripe transition"
            >
              <span className="text-sh-black font-medium flex items-center gap-2">
                <span className="inline-block w-3 text-sh-gray">{dExpanded ? "▾" : "▸"}</span>
                {dRow.dept}
              </span>
              <span className="text-xs text-sh-gray">
                {dRow.itemCount} · <span className="text-sh-black">{fmt(dRow.netSales)}</span>
              </span>
            </button>
            {dExpanded && (
              <SupplierCategoryRows
                vendor={vendor}
                dept={dRow.dept}
                categories={dRow.categories}
                expandedKey={expandedKey}
                itemsByKey={itemsByKey}
                itemsLoading={itemsLoading}
                onCategoryDrill={onCategoryDrill}
                onEdit={onEdit}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function SupplierCategoryRows({
  vendor,
  dept,
  categories,
  expandedKey,
  itemsByKey,
  itemsLoading,
  onCategoryDrill,
  onEdit,
}: Readonly<{
  vendor: string;
  dept: string;
  categories: Map<string, { netSales: number; taxCollected: number; itemCount: number }>;
  expandedKey: string | null;
  itemsByKey: Record<string, DrilldownItem[]>;
  itemsLoading: string | null;
  onCategoryDrill: (vendor: string, dept: string, cat: string) => void;
  onEdit: (item: DrilldownItem) => void;
}>) {
  const fmt = useMoneyFormatter();
  const catRows = Array.from(categories.entries())
    .map(([cat, entry]) => ({ cat, ...entry }))
    .sort((a, b) => b.netSales - a.netSales);

  return (
    <div className="pl-6 pb-2">
      {catRows.map((cRow) => {
        const cKey = `vendor:${vendor}|${dept}|${cRow.cat}`;
        const cExpanded = expandedKey === cKey;
        const items = itemsByKey[cKey];
        const isLoading = itemsLoading === cKey;
        return (
          <div key={cRow.cat}>
            <button
              type="button"
              onClick={() => onCategoryDrill(vendor, dept, cRow.cat)}
              className="w-full flex items-center justify-between py-1.5 px-2 text-xs hover:bg-sh-stripe transition"
            >
              <span className="text-sh-gray flex items-center gap-2">
                <span className="inline-block w-3">{cExpanded ? "▾" : "▸"}</span>
                {cRow.cat}
              </span>
              <span className="text-sh-gray">
                {cRow.itemCount} · {fmt(cRow.netSales)}
              </span>
            </button>
            {cExpanded && (
              <div className="bg-sh-linen/30 px-3 py-2 border border-sh-gray/10">
                <SupplierItemList isLoading={isLoading} items={items} onEdit={onEdit} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SupplierItemList({
  isLoading,
  items,
  onEdit,
}: Readonly<{
  isLoading: boolean;
  items: DrilldownItem[] | undefined;
  onEdit: (item: DrilldownItem) => void;
}>) {
  const fmt = useMoneyFormatter();
  if (isLoading) return <p className="text-xs text-sh-gray">Loading line items…</p>;
  if (!items || items.length === 0) {
    return <p className="text-xs text-sh-gray">No line items in this bucket.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-sh-gray border-b border-sh-gray/20">
            <th className="py-1.5 pr-3">Order</th>
            <th className="py-1.5 pr-3">Customer</th>
            <th className="py-1.5 pr-3">Date</th>
            <th className="py-1.5 pr-3">Type</th>
            <th className="py-1.5 pr-3">Part #</th>
            <th className="py-1.5 pr-3">Item</th>
            <th className="py-1.5 pr-3 text-right">Net</th>
            <th className="py-1.5 pr-3"></th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr key={it.id} className="border-b border-sh-gray/10">
              <td className="py-1.5 pr-3">
                <Link
                  href={`/app/sales/orders/${it.orderId}`}
                  className="text-sh-blue hover:underline"
                >
                  {it.orderno}
                </Link>
              </td>
              <td className="py-1.5 pr-3 text-sh-black">{it.customerName ?? "—"}</td>
              <td className="py-1.5 pr-3 text-sh-gray">
                {it.orderDate ? parseLocalDate(it.orderDate).toLocaleDateString() : "—"}
              </td>
              <td className="py-1.5 pr-3 text-sh-gray">{it.typeName ?? "—"}</td>
              <td className="py-1.5 pr-3 font-mono text-[11px]">{it.partNo ?? ""}</td>
              <td className="py-1.5 pr-3 text-sh-black max-w-[260px] truncate">
                {it.productName ?? "—"}
              </td>
              <td className="py-1.5 pr-3 text-right">{fmt(it.netPrice)}</td>
              <td className="py-1.5 pr-3">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit(it);
                  }}
                  className="text-sh-blue hover:underline"
                >
                  Edit
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {items.length >= 500 && (
        <p className="text-xs text-sh-gray mt-2">
          Showing first 500 items. Narrow the date range or filters to see others.
        </p>
      )}
    </div>
  );
}

export function DetailedSalesView() {
  const fmt = useMoneyFormatter();
  const utils = api.useUtils();
  const [sales, setSales] = useState<SalesRow[]>([]);
  const [dateRange, setDateRange] = useState(() => {
    // Default to yesterday only -- the most common manager check is "what
    // happened yesterday." Range can still be widened from the picker.
    const yesterday = format(startOfDay(subDays(new Date(), 1)), "yyyy-MM-dd");
    return { startDate: yesterday, endDate: yesterday };
  });
  const [loading, setLoading] = useState(false);
  const [hasRun, setHasRun] = useState(false);
  const [selectedDepartments, setSelectedDepartments] = useState<Set<string>>(new Set());
  const [selectedStores, setSelectedStores] = useState<Set<string>>(new Set());
  const [selectedVendors, setSelectedVendors] = useState<Set<string>>(new Set());
  const [pivot, setPivot] = useState<Pivot>("department");

  // Drilldown state. Key shape varies by pivot + level:
  //   `${store}|${department}`    — dept row in dept pivot
  //   `${store}|*`                — all-store drill in dept pivot
  //   `vendor:${vendor}`          — vendor pivot top row
  //   `vendor:${vendor}|${dept}`  — vendor → dept sub-row
  //   `vendor:${vendor}|${dept}|${cat}` — vendor → dept → category drill (line items)
  //   `${store}|${department}|${vendor}` — vendor sub-row inside the dept pivot
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [itemsByKey, setItemsByKey] = useState<Record<string, DrilldownItem[]>>({});
  const [itemsLoading, setItemsLoading] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<DrilldownItem | null>(null);

  const allDepartments = useMemo(() => {
    return Array.from(new Set(sales.map((s) => s.department))).sort((a, b) => a.localeCompare(b));
  }, [sales]);

  const allStores = useMemo(() => {
    return Array.from(new Set(sales.map((s) => s.storeLocation))).sort((a, b) =>
      a.localeCompare(b),
    );
  }, [sales]);

  const allVendors = useMemo(() => {
    return Array.from(new Set(sales.map((s) => s.vendor))).sort((a, b) => a.localeCompare(b));
  }, [sales]);

  const filteredSales = useMemo(() => {
    let r = sales;
    if (selectedDepartments.size > 0) {
      r = r.filter((s) => selectedDepartments.has(s.department));
    }
    if (selectedStores.size > 0) {
      r = r.filter((s) => selectedStores.has(s.storeLocation));
    }
    if (selectedVendors.size > 0) {
      r = r.filter((s) => selectedVendors.has(s.vendor));
    }
    return r;
  }, [sales, selectedDepartments, selectedStores, selectedVendors]);

  const storeSummary = useMemo(() => {
    const byStore = new Map<
      string,
      { netSales: number; taxCollected: number; itemCount: number }
    >();
    for (const row of filteredSales) {
      const existing = byStore.get(row.storeLocation);
      if (existing) {
        existing.netSales += row.netSales;
        existing.taxCollected += row.taxCollected;
        existing.itemCount += row.itemCount;
      } else {
        byStore.set(row.storeLocation, {
          netSales: row.netSales,
          taxCollected: row.taxCollected,
          itemCount: row.itemCount,
        });
      }
    }
    return Array.from(byStore.entries())
      .map(([store, totals]) => ({ store, ...totals }))
      .sort((a, b) => b.netSales - a.netSales);
  }, [filteredSales]);

  // Group by store then department for the breakdown
  const storeBreakdown = useMemo(() => {
    const grouped = new Map<
      string,
      Map<string, { netSales: number; taxCollected: number; itemCount: number }>
    >();
    for (const row of filteredSales) {
      if (!grouped.has(row.storeLocation)) {
        grouped.set(row.storeLocation, new Map());
      }
      const deptMap = grouped.get(row.storeLocation)!;
      const existing = deptMap.get(row.department);
      if (existing) {
        existing.netSales += row.netSales;
        existing.taxCollected += row.taxCollected;
        existing.itemCount += row.itemCount;
      } else {
        deptMap.set(row.department, {
          netSales: row.netSales,
          taxCollected: row.taxCollected,
          itemCount: row.itemCount,
        });
      }
    }
    return grouped;
  }, [filteredSales]);

  const grandTotal = useMemo(() => {
    return filteredSales.reduce(
      (acc, row) => ({
        netSales: acc.netSales + row.netSales,
        taxCollected: acc.taxCollected + row.taxCollected,
        itemCount: acc.itemCount + row.itemCount,
      }),
      { netSales: 0, taxCollected: 0, itemCount: 0 },
    );
  }, [filteredSales]);

  // Vendor pivot: vendor → department → category (3-level rollup).
  // Each Map is keyed by name; values carry running totals so the page
  // can render top-level vendor rows with totals, expand to dept rows
  // with totals, then to category rows that drill to line items.
  const vendorBreakdown = useMemo(() => {
    type DeptEntry = {
      categories: Map<string, { netSales: number; taxCollected: number; itemCount: number }>;
      netSales: number;
      taxCollected: number;
      itemCount: number;
    };
    const byVendor = new Map<
      string,
      {
        departments: Map<string, DeptEntry>;
        netSales: number;
        taxCollected: number;
        itemCount: number;
      }
    >();
    for (const row of filteredSales) {
      let vendorEntry = byVendor.get(row.vendor);
      if (!vendorEntry) {
        vendorEntry = { departments: new Map(), netSales: 0, taxCollected: 0, itemCount: 0 };
        byVendor.set(row.vendor, vendorEntry);
      }
      vendorEntry.netSales += row.netSales;
      vendorEntry.taxCollected += row.taxCollected;
      vendorEntry.itemCount += row.itemCount;

      let deptEntry = vendorEntry.departments.get(row.department);
      if (!deptEntry) {
        deptEntry = { categories: new Map(), netSales: 0, taxCollected: 0, itemCount: 0 };
        vendorEntry.departments.set(row.department, deptEntry);
      }
      deptEntry.netSales += row.netSales;
      deptEntry.taxCollected += row.taxCollected;
      deptEntry.itemCount += row.itemCount;

      const catKey = row.category || "(no category)";
      const catEntry = deptEntry.categories.get(catKey);
      if (catEntry) {
        catEntry.netSales += row.netSales;
        catEntry.taxCollected += row.taxCollected;
        catEntry.itemCount += row.itemCount;
      } else {
        deptEntry.categories.set(catKey, {
          netSales: row.netSales,
          taxCollected: row.taxCollected,
          itemCount: row.itemCount,
        });
      }
    }
    return byVendor;
  }, [filteredSales]);

  const runReport = useCallback(async () => {
    setLoading(true);
    setSelectedDepartments(new Set());
    try {
      const rows = await utils.reports.detailedSales.fetch({
        startDate: dateRange.startDate,
        endDate: dateRange.endDate,
      });
      setSales(rows);
      setHasRun(true);
    } catch {
      toast.error("Failed to load sales data");
    } finally {
      setLoading(false);
    }
  }, [dateRange, utils]);

  async function toggleDrilldown(store: string, department: string) {
    const key = `${store}|${department}`;
    if (expandedKey === key) {
      setExpandedKey(null);
      return;
    }
    setExpandedKey(key);
    if (itemsByKey[key]) return; // already loaded
    setItemsLoading(key);
    try {
      const rows = await utils.reports.detailedSalesItems.fetch({
        store,
        department,
        startDate: dateRange.startDate,
        endDate: dateRange.endDate,
      });
      setItemsByKey((prev) => ({ ...prev, [key]: rows }));
    } catch {
      toast.error("Failed to load items.");
      setExpandedKey(null);
    } finally {
      setItemsLoading(null);
    }
  }

  /**
   * Drill from a store row -- shows all line items in the store regardless
   * of department. Uses key `${store}|*` to disambiguate from the per-dept
   * drilldown above; the items API treats absent `department` as "all".
   */
  async function toggleStoreDrilldown(store: string) {
    const key = `${store}|*`;
    if (expandedKey === key) {
      setExpandedKey(null);
      return;
    }
    setExpandedKey(key);
    if (itemsByKey[key]) return;
    setItemsLoading(key);
    try {
      const rows = await utils.reports.detailedSalesItems.fetch({
        store,
        startDate: dateRange.startDate,
        endDate: dateRange.endDate,
      });
      setItemsByKey((prev) => ({ ...prev, [key]: rows }));
    } catch {
      toast.error("Failed to load items.");
      setExpandedKey(null);
    } finally {
      setItemsLoading(null);
    }
  }

  /**
   * Drill from a vendor-pivot category cell — fetches line items
   * filtered to (vendor, department, category). The dataset is
   * cross-store by design in the supplier pivot.
   */
  async function toggleVendorCategoryDrilldown(vendor: string, dept: string, cat: string) {
    const key = `vendor:${vendor}|${dept}|${cat}`;
    if (expandedKey === key) {
      setExpandedKey(null);
      return;
    }
    setExpandedKey(key);
    if (itemsByKey[key]) return;
    setItemsLoading(key);
    try {
      const rows = await utils.reports.detailedSalesItems.fetch({
        vendor,
        department: dept,
        category: cat === "(no category)" ? undefined : cat,
        startDate: dateRange.startDate,
        endDate: dateRange.endDate,
      });
      setItemsByKey((prev) => ({ ...prev, [key]: rows }));
    } catch {
      toast.error("Failed to load items.");
      setExpandedKey(null);
    } finally {
      setItemsLoading(null);
    }
  }

  /**
   * Triggers a download of the current view as CSV. Server endpoint
   * shapes the rolled rows (level=group); items export is a different
   * level the user can hit from a drilldown context if we add the
   * affordance later. Stays a REST download — the export route is
   * untouched during the migration.
   */
  function exportCsv() {
    const params = new URLSearchParams();
    params.set("level", "group");
    if (dateRange.startDate) params.set("startDate", dateRange.startDate);
    if (dateRange.endDate) params.set("endDate", dateRange.endDate);
    if (selectedStores.size > 0) params.set("stores", Array.from(selectedStores).join(","));
    if (selectedDepartments.size > 0) {
      params.set("departments", Array.from(selectedDepartments).join(","));
    }
    if (selectedVendors.size > 0) params.set("vendors", Array.from(selectedVendors).join(","));
    window.open(`/api/reports/detailed-sales/export?${params.toString()}`, "_blank");
  }

  function handleEdited(updatedItem: DrilldownItem) {
    // Refresh the drilldown row. Easiest: invalidate this cell's cache so the
    // user sees correct department if they changed it, and refresh summary.
    setItemsByKey((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        next[key] = next[key].map((it) => (it.id === updatedItem.id ? updatedItem : it));
      }
      return next;
    });
    setEditTarget(null);
    // Re-run report to recompute totals (the line now contributes to a
    // different department bucket).
    runReport();
  }

  const [relinking, setRelinking] = useState(false);

  async function handleRelinkAll() {
    setRelinking(true);
    try {
      const res = await axios.post<{ updated: number; remainingUnlinked: number }>(
        "/api/admin/relink-line-items",
      );
      toast.success(
        `Linked ${res.data.updated.toLocaleString()} line item${res.data.updated === 1 ? "" : "s"}.`,
      );
      // Clear drilldown cache + re-run so categorization reflects new links.
      setItemsByKey({});
      setExpandedKey(null);
      if (hasRun) runReport();
    } catch {
      toast.error("Relink failed. Check server logs.");
    } finally {
      setRelinking(false);
    }
  }

  return (
    <div className="max-w-screen-lg mx-auto py-2 font-serif space-y-6">
      <h1 className="text-2xl font-semibold text-sh-blue">Sales by Department</h1>

      {/* Filter bar: date range + dept filter + run + relink */}
      <div className="bg-white border border-sh-gray/20 rounded-lg shadow-sm p-4">
        <div className="flex items-end gap-3 flex-wrap">
          <div className="flex-1 min-w-[240px]">
            <DateRangeFilter value={dateRange} onChange={setDateRange} />
          </div>
          <div>
            <p className="block text-xs font-semibold text-sh-gray uppercase tracking-wide mb-1">
              Stores
            </p>
            <MultiSelectDropdown
              label="Stores"
              options={allStores.map((s) => ({ value: s, label: s }))}
              selected={Array.from(selectedStores)}
              onChange={(next) => setSelectedStores(new Set(next))}
              emptyLabel="All stores"
            />
          </div>
          <div>
            <p className="block text-xs font-semibold text-sh-gray uppercase tracking-wide mb-1">
              Departments
            </p>
            <MultiSelectDropdown
              label="Departments"
              options={allDepartments.map((d) => ({ value: d, label: d }))}
              selected={Array.from(selectedDepartments)}
              onChange={(next) => setSelectedDepartments(new Set(next))}
              emptyLabel="All departments"
            />
          </div>
          <div>
            <p className="block text-xs font-semibold text-sh-gray uppercase tracking-wide mb-1">
              Vendors
            </p>
            <MultiSelectDropdown
              label="Vendors"
              options={allVendors.map((v) => ({ value: v, label: v }))}
              selected={Array.from(selectedVendors)}
              onChange={(next) => setSelectedVendors(new Set(next))}
              emptyLabel="All vendors"
            />
          </div>
          <Button onClick={runReport} disabled={loading} className="h-[42px] px-6">
            {loading ? "Loading..." : "Run Report"}
          </Button>
          <button
            type="button"
            onClick={exportCsv}
            disabled={!hasRun || filteredSales.length === 0}
            title="Download the current rolled-up view as CSV (store / department / category / vendor)."
            className="h-[42px] px-4 text-sm border border-sh-gray/30 text-sh-gray hover:bg-sh-linen rounded-lg transition disabled:opacity-50"
          >
            Export CSV
          </button>
          <button
            type="button"
            onClick={handleRelinkAll}
            disabled={relinking || loading}
            title="Match all unlinked line items to products by part number / UPC. Run this after a product import to fix Uncategorized rows."
            className="h-[42px] px-4 text-sm border border-sh-gray/30 text-sh-gray hover:bg-sh-linen rounded-lg transition disabled:opacity-50"
          >
            {relinking ? "Relinking…" : "Relink Line Items"}
          </button>
        </div>

        {/* Pivot toggle: Department (default) shows store→dept→items.
            Supplier pivots to vendor→dept→category→items, cross-store. */}
        {hasRun && (
          <div className="mt-3 flex items-center gap-2 text-sm">
            <span className="text-xs font-semibold text-sh-gray uppercase tracking-wide">
              Pivot:
            </span>
            <div className="inline-flex rounded-lg border border-sh-gray/30 overflow-hidden">
              <button
                type="button"
                onClick={() => {
                  setPivot("department");
                  setExpandedKey(null);
                }}
                className={`px-3 py-1.5 transition ${
                  pivot === "department"
                    ? "bg-sh-blue text-white"
                    : "bg-white text-sh-gray hover:bg-sh-linen"
                }`}
              >
                By Department
              </button>
              <button
                type="button"
                onClick={() => {
                  setPivot("vendor");
                  setExpandedKey(null);
                }}
                className={`px-3 py-1.5 transition border-l border-sh-gray/30 ${
                  pivot === "vendor"
                    ? "bg-sh-blue text-white"
                    : "bg-white text-sh-gray hover:bg-sh-linen"
                }`}
              >
                By Supplier
              </button>
            </div>
          </div>
        )}
      </div>

      {renderBody()}

      {editTarget && (
        <EditLineItemModal
          item={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={handleEdited}
        />
      )}
    </div>
  );

  // Top-level body: loading / not-run / empty / results. Mirrors the legacy
  // nested ternary chain but extracted to a helper for readability (S3358).
  function renderBody() {
    if (loading) {
      return <p className="text-sh-gray text-center py-8">Loading...</p>;
    }
    if (!hasRun) {
      return (
        <p className="text-sh-gray text-center py-8">Set a date range and click Run Report.</p>
      );
    }
    if (filteredSales.length === 0) {
      return <p className="text-sh-gray text-center py-8">No sales data for this period.</p>;
    }
    return (
      <>
        {/* Summary by store */}
        <div className="bg-white border border-sh-gray/20 rounded-lg shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-sh-linen border-b border-sh-gray/20">
                <th className="text-left p-3 font-semibold text-sh-black">Store</th>
                <th className="text-right p-3 font-semibold text-sh-black">Items</th>
                <th className="text-right p-3 font-semibold text-sh-black">Net Sales</th>
                <th className="text-right p-3 font-semibold text-sh-black">Tax</th>
                <th className="text-right p-3 font-semibold text-sh-black">Total</th>
              </tr>
            </thead>
            <tbody>
              {storeSummary.map((row) => (
                <tr key={row.store} className="border-b border-sh-gray/10 hover:bg-sh-stripe">
                  <td className="p-3 text-sh-black font-medium">{row.store}</td>
                  <td className="p-3 text-right text-sh-gray">{row.itemCount}</td>
                  <td className="p-3 text-right text-sh-black">{fmt(row.netSales)}</td>
                  <td className="p-3 text-right text-sh-gray">{fmt(row.taxCollected)}</td>
                  <td className="p-3 text-right font-medium text-sh-black">
                    {fmt(row.netSales + row.taxCollected)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-sh-linen border-t-2 border-sh-gray/30">
                <td className="p-3 font-semibold text-sh-black">Total</td>
                <td className="p-3 text-right font-semibold text-sh-black">
                  {grandTotal.itemCount}
                </td>
                <td className="p-3 text-right font-semibold text-sh-black">
                  {fmt(grandTotal.netSales)}
                </td>
                <td className="p-3 text-right font-semibold text-sh-gray">
                  {fmt(grandTotal.taxCollected)}
                </td>
                <td className="p-3 text-right font-semibold text-sh-black">
                  {fmt(grandTotal.netSales + grandTotal.taxCollected)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        {/* Supplier pivot — rendered when user toggled "By Supplier".
            Three drill levels: vendor → dept → category → line items. */}
        {pivot === "vendor" && (
          <SupplierPivotView
            vendorBreakdown={vendorBreakdown}
            expandedKey={expandedKey}
            setExpandedKey={setExpandedKey}
            itemsByKey={itemsByKey}
            itemsLoading={itemsLoading}
            onCategoryDrill={toggleVendorCategoryDrilldown}
            onEdit={setEditTarget}
          />
        )}

        {/* Department breakdown by store */}
        {pivot === "department" &&
          Array.from(storeBreakdown.entries()).map(([store, departments]) => {
            const deptRows = Array.from(departments.entries())
              .map(([dept, totals]) => ({ department: dept, ...totals }))
              .sort((a, b) => b.netSales - a.netSales);

            const storeKey = `${store}|*`;
            const storeExpanded = expandedKey === storeKey;
            const storeItems = itemsByKey[storeKey];
            const storeLoading = itemsLoading === storeKey;
            const storeTotals = deptRows.reduce(
              (acc, r) => ({
                itemCount: acc.itemCount + r.itemCount,
                netSales: acc.netSales + r.netSales,
                taxCollected: acc.taxCollected + r.taxCollected,
              }),
              { itemCount: 0, netSales: 0, taxCollected: 0 },
            );

            return (
              <div
                key={store}
                className="bg-white border border-sh-gray/20 rounded-lg shadow-sm overflow-hidden"
              >
                <button
                  type="button"
                  onClick={() => toggleStoreDrilldown(store)}
                  className={`w-full text-left bg-sh-linen px-3 py-2 border-b border-sh-gray/20 cursor-pointer transition flex items-center justify-between ${
                    storeExpanded ? "bg-sh-linen/80" : "hover:bg-sh-linen/60"
                  }`}
                  title="Click to drill down to all line items in this store"
                >
                  <h3 className="text-sm font-semibold text-sh-blue flex items-center gap-2">
                    <span className="inline-block w-3 text-sh-gray">
                      {storeExpanded ? "▾" : "▸"}
                    </span>
                    {store}
                  </h3>
                  <span className="text-xs text-sh-gray">
                    {storeTotals.itemCount.toLocaleString()} item
                    {storeTotals.itemCount === 1 ? "" : "s"} ·{" "}
                    <span className="font-semibold text-sh-black">{fmt(storeTotals.netSales)}</span>
                  </span>
                </button>
                {storeExpanded && (
                  <div className="bg-sh-linen/30 px-4 py-3 border-b border-sh-gray/20">
                    <StoreDrilldownContent isLoading={storeLoading} items={storeItems} />
                  </div>
                )}
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-sh-gray/10">
                      <th className="text-left p-3 text-xs font-semibold text-sh-gray uppercase tracking-wide">
                        Department
                      </th>
                      <th className="text-right p-3 text-xs font-semibold text-sh-gray uppercase tracking-wide">
                        Items
                      </th>
                      <th className="text-right p-3 text-xs font-semibold text-sh-gray uppercase tracking-wide">
                        Net Sales
                      </th>
                      <th className="text-right p-3 text-xs font-semibold text-sh-gray uppercase tracking-wide">
                        Tax
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {deptRows.map((row) => {
                      const key = `${store}|${row.department}`;
                      const isExpanded = expandedKey === key;
                      const items = itemsByKey[key];
                      const isLoading = itemsLoading === key;
                      const isUncategorized = row.department === "Uncategorized";
                      return (
                        <Fragment key={row.department}>
                          <tr
                            onClick={() => toggleDrilldown(store, row.department)}
                            className={`border-b border-sh-gray/10 cursor-pointer transition ${
                              isExpanded ? "bg-sh-linen/60" : "hover:bg-sh-stripe"
                            } ${isUncategorized ? "text-amber-700" : ""}`}
                          >
                            <td className="p-3 font-medium">
                              <span className="inline-block w-4 text-sh-gray">
                                {isExpanded ? "▾" : "▸"}
                              </span>
                              {row.department}
                            </td>
                            <td className="p-3 text-right text-sh-gray">{row.itemCount}</td>
                            <td className="p-3 text-right">{fmt(row.netSales)}</td>
                            <td className="p-3 text-right text-sh-gray">{fmt(row.taxCollected)}</td>
                          </tr>
                          {isExpanded && (
                            <tr>
                              <td colSpan={4} className="bg-sh-linen/30 px-4 py-3">
                                <DeptDrilldownContent
                                  isLoading={isLoading}
                                  items={items}
                                  onEdit={setEditTarget}
                                />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          })}
      </>
    );
  }
}

/**
 * Body of an expanded department-row drilldown (department pivot). Three states
 * flattened with early returns (S3358). Extracted from the inline JSX in the
 * legacy page so the parent's map stays readable.
 */
function DeptDrilldownContent({
  isLoading,
  items,
  onEdit,
}: Readonly<{
  isLoading: boolean;
  items: DrilldownItem[] | undefined;
  onEdit: (item: DrilldownItem) => void;
}>) {
  const fmt = useMoneyFormatter();
  if (isLoading) {
    return <p className="text-sm text-sh-gray">Loading line items…</p>;
  }
  if (!items || items.length === 0) {
    return <p className="text-sm text-sh-gray">No line items for this bucket.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-sh-gray border-b border-sh-gray/20">
            <th className="py-1.5 pr-3">Order</th>
            <th className="py-1.5 pr-3">Customer</th>
            <th className="py-1.5 pr-3">Date</th>
            <th className="py-1.5 pr-3">Part #</th>
            <th className="py-1.5 pr-3">Item</th>
            <th className="py-1.5 pr-3 text-right">Net</th>
            <th className="py-1.5 pr-3"></th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr key={it.id} className="border-b border-sh-gray/10">
              <td className="py-1.5 pr-3">
                <Link
                  href={`/app/sales/orders/${it.orderId}`}
                  className="text-sh-blue hover:underline"
                >
                  {it.orderno}
                </Link>
              </td>
              <td className="py-1.5 pr-3 text-sh-black">{it.customerName ?? "—"}</td>
              <td className="py-1.5 pr-3 text-sh-gray">
                {it.orderDate ? parseLocalDate(it.orderDate).toLocaleDateString() : "—"}
              </td>
              <td className="py-1.5 pr-3 font-mono text-[11px]">{it.partNo ?? ""}</td>
              <td className="py-1.5 pr-3 text-sh-black max-w-[320px] truncate">
                {it.productName ?? "—"}
              </td>
              <td className="py-1.5 pr-3 text-right">{fmt(it.netPrice)}</td>
              <td className="py-1.5 pr-3">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit(it);
                  }}
                  className="text-sh-blue hover:underline"
                >
                  Edit
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {items.length >= 500 && (
        <p className="text-xs text-sh-gray mt-2">
          Showing first 500 items. Narrow the date range or department filter to see others.
        </p>
      )}
    </div>
  );
}

// ── Edit Line Item Modal ────────────────────────────────────────────────────
function EditLineItemModal({
  item,
  onClose,
  onSaved,
}: Readonly<{
  item: DrilldownItem;
  onClose: () => void;
  onSaved: (updated: DrilldownItem) => void;
}>) {
  const fmt = useMoneyFormatter();
  const [tab, setTab] = useState<"link" | "create">("link");
  const [query, setQuery] = useState(item.partNo ?? "");
  const [hits, setHits] = useState<ProductSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedProductId, setSelectedProductId] = useState<number | null>(item.productId);

  // Create-new-product tab state
  const [newName, setNewName] = useState(item.productName ?? "");
  const [newPartNo, setNewPartNo] = useState(item.partNo ?? "");
  const [newUpc, setNewUpc] = useState(item.barcode ?? "");
  const [newCost, setNewCost] = useState<string>("");
  const [newRetail, setNewRetail] = useState<string>(
    item.netPrice > 0 && item.orderedQuantity > 0
      ? (item.netPrice / item.orderedQuantity).toFixed(2)
      : "",
  );
  const [taxonomy, setTaxonomy] = useState<{
    vendorId: number | null;
    departmentId: number | null;
    categoryId: number | null;
    typeId: number | null;
  }>({ vendorId: null, departmentId: null, categoryId: null, typeId: null });

  async function runSearch() {
    if (!query.trim()) {
      setHits([]);
      return;
    }
    setSearching(true);
    try {
      const res = await axios.get<{ products: ProductSearchHit[] }>("/api/products", {
        params: { search: query.trim(), limit: 15 },
      });
      setHits(
        (res.data.products ?? []).map((p) => ({
          id: p.id,
          name: p.name,
          productNumber: p.productNumber,
          departmentName: (p as unknown as { departmentName?: string }).departmentName ?? null,
          categoryName: (p as unknown as { categoryName?: string }).categoryName ?? null,
          vendorName: (p as unknown as { vendorName?: string }).vendorName ?? null,
        })),
      );
    } catch {
      toast.error("Product search failed.");
    } finally {
      setSearching(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      await axios.put(`/api/sales/orders/${item.orderId}/line-items/${item.id}`, {
        action: "relink",
        productId: selectedProductId,
        reason: "Manual relink from Detailed Sales report",
      });
      toast.success(
        selectedProductId
          ? "Line item linked."
          : "Line item unlinked (will show as Uncategorized).",
      );
      const picked = hits.find((h) => h.id === selectedProductId);
      onSaved({
        ...item,
        productId: selectedProductId,
        productNumber: picked?.productNumber ?? null,
        departmentName: picked?.departmentName ?? null,
        categoryName: picked?.categoryName ?? null,
      });
    } catch {
      toast.error("Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  async function handleCreateAndLink() {
    if (!newName.trim()) return toast.error("Name is required.");
    if (!newPartNo.trim()) return toast.error("Part number is required.");
    if (!taxonomy.vendorId) return toast.error("Vendor is required.");
    if (!taxonomy.departmentId) return toast.error("Department is required.");
    if (!taxonomy.categoryId) return toast.error("Category is required.");

    setSaving(true);
    try {
      const createRes = await axios.post<{ id: number }>("/api/products/quick-create", {
        name: newName.trim(),
        productNumber: newPartNo.trim(),
        vendorId: taxonomy.vendorId,
        departmentId: taxonomy.departmentId,
        categoryId: taxonomy.categoryId,
        typeId: taxonomy.typeId ?? null,
        upc: newUpc.trim() || null,
        baseCost: newCost ? Number.parseFloat(newCost) : null,
        baseRetail: newRetail ? Number.parseFloat(newRetail) : null,
      });
      const newProductId = createRes.data.id;
      await axios.put(`/api/sales/orders/${item.orderId}/line-items/${item.id}`, {
        action: "relink",
        productId: newProductId,
        reason: "Created new product from Detailed Sales drilldown",
      });
      toast.success(`Created product and linked line item.`);
      onSaved({
        ...item,
        productId: newProductId,
        productNumber: newPartNo.trim(),
        departmentName: null, // will be refreshed by the re-run
        categoryName: null,
      });
    } catch (err) {
      const msg =
        axios.isAxiosError(err) && err.response?.data?.error
          ? err.response.data.error
          : "Failed to create product.";
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
      role="presentation"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl p-6 space-y-5 max-h-[90vh] overflow-y-auto">
        <div>
          <h2 className="text-lg font-semibold text-sh-black font-serif">Edit Line Item</h2>
          <p className="text-sm text-sh-gray mt-0.5">
            {item.orderno} · {item.customerName ?? "no customer"} ·{" "}
            {item.orderDate ? parseLocalDate(item.orderDate).toLocaleDateString() : "—"} ·{" "}
            {fmt(item.netPrice)}
          </p>
          <p className="text-xs text-sh-gray mt-1">
            Part # <span className="font-mono">{item.partNo ?? "—"}</span> · Currently:{" "}
            {item.departmentName ? (
              <>
                {item.departmentName}
                {item.categoryName ? ` / ${item.categoryName}` : ""}
              </>
            ) : (
              <em>Uncategorized</em>
            )}
          </p>
        </div>

        <div className="flex gap-2 border-b border-sh-gray/20">
          <button
            type="button"
            onClick={() => setTab("link")}
            className={`px-4 py-2 text-sm font-semibold min-h-[40px] transition ${
              tab === "link"
                ? "text-sh-blue border-b-2 border-sh-blue"
                : "text-sh-gray hover:text-sh-black"
            }`}
          >
            Link to existing
          </button>
          <button
            type="button"
            onClick={() => setTab("create")}
            className={`px-4 py-2 text-sm font-semibold min-h-[40px] transition ${
              tab === "create"
                ? "text-sh-blue border-b-2 border-sh-blue"
                : "text-sh-gray hover:text-sh-black"
            }`}
          >
            Create new product
          </button>
        </div>

        {tab === "link" && (
          <div>
            <label
              htmlFor="detailed-sales-product-search"
              className="block text-xs font-semibold text-sh-gray uppercase tracking-wide mb-1"
            >
              Search product (by name, part #, or UPC)
            </label>
            <div className="flex gap-2">
              <input
                id="detailed-sales-product-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") runSearch();
                }}
                className="flex-1 border border-sh-gray/30 rounded-lg px-3 py-2 text-sm text-sh-black focus:outline-none focus:ring-1 focus:ring-sh-blue"
                placeholder={item.partNo ?? "e.g. SKU-217029, ACC-9381"}
              />
              <Button
                onClick={runSearch}
                disabled={searching || !query.trim()}
                className="min-h-[40px] px-4"
              >
                {searching ? "…" : "Search"}
              </Button>
            </div>
          </div>
        )}

        {tab === "link" && hits.length > 0 && (
          <div className="border border-sh-gray/20 rounded-lg divide-y divide-sh-gray/10 max-h-64 overflow-y-auto">
            {hits.map((h) => (
              <button
                type="button"
                key={h.id}
                onClick={() => setSelectedProductId(h.id)}
                className={`w-full text-left px-3 py-2 hover:bg-sh-linen transition ${
                  selectedProductId === h.id ? "bg-sh-linen" : ""
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-sh-black truncate">{h.name}</p>
                    <p className="text-xs text-sh-gray">
                      <span className="font-mono">{h.productNumber}</span>
                      {h.vendorName ? ` · ${h.vendorName}` : ""}
                      {h.departmentName ? ` · ${h.departmentName}` : ""}
                      {h.categoryName ? ` / ${h.categoryName}` : ""}
                    </p>
                  </div>
                  {selectedProductId === h.id && (
                    <span className="text-sh-blue text-xs font-semibold shrink-0">Selected</span>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}

        {tab === "link" && query && !searching && hits.length === 0 && (
          <p className="text-sm text-sh-gray italic">
            No matches. Switch to{" "}
            <button
              type="button"
              onClick={() => setTab("create")}
              className="text-sh-blue underline"
            >
              Create new product
            </button>{" "}
            to add it right here.
          </p>
        )}

        {tab === "create" && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="detailed-sales-new-name"
                  className="block text-xs font-semibold text-sh-gray uppercase tracking-wide mb-1"
                >
                  Name <span className="text-red-500">*</span>
                </label>
                <input
                  id="detailed-sales-new-name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-full border border-sh-gray/30 rounded-lg px-3 py-2 text-sm text-sh-black min-h-[40px] focus:outline-none focus:ring-1 focus:ring-sh-blue"
                />
              </div>
              <div>
                <label
                  htmlFor="detailed-sales-new-partno"
                  className="block text-xs font-semibold text-sh-gray uppercase tracking-wide mb-1"
                >
                  Part Number <span className="text-red-500">*</span>
                </label>
                <input
                  id="detailed-sales-new-partno"
                  value={newPartNo}
                  onChange={(e) => setNewPartNo(e.target.value)}
                  className="w-full border border-sh-gray/30 rounded-lg px-3 py-2 text-sm text-sh-black font-mono min-h-[40px] focus:outline-none focus:ring-1 focus:ring-sh-blue"
                />
              </div>
              <div>
                <label
                  htmlFor="detailed-sales-new-upc"
                  className="block text-xs font-semibold text-sh-gray uppercase tracking-wide mb-1"
                >
                  UPC / Barcode
                </label>
                <input
                  id="detailed-sales-new-upc"
                  value={newUpc}
                  onChange={(e) => setNewUpc(e.target.value)}
                  className="w-full border border-sh-gray/30 rounded-lg px-3 py-2 text-sm text-sh-black font-mono min-h-[40px] focus:outline-none focus:ring-1 focus:ring-sh-blue"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="detailed-sales-new-cost"
                    className="block text-xs font-semibold text-sh-gray uppercase tracking-wide mb-1"
                  >
                    Cost
                  </label>
                  <input
                    id="detailed-sales-new-cost"
                    value={newCost}
                    onChange={(e) => setNewCost(e.target.value)}
                    type="number"
                    step="0.01"
                    className="w-full border border-sh-gray/30 rounded-lg px-3 py-2 text-sm text-sh-black min-h-[40px] focus:outline-none focus:ring-1 focus:ring-sh-blue"
                  />
                </div>
                <div>
                  <label
                    htmlFor="detailed-sales-new-retail"
                    className="block text-xs font-semibold text-sh-gray uppercase tracking-wide mb-1"
                  >
                    Retail
                  </label>
                  <input
                    id="detailed-sales-new-retail"
                    value={newRetail}
                    onChange={(e) => setNewRetail(e.target.value)}
                    type="number"
                    step="0.01"
                    className="w-full border border-sh-gray/30 rounded-lg px-3 py-2 text-sm text-sh-black min-h-[40px] focus:outline-none focus:ring-1 focus:ring-sh-blue"
                  />
                </div>
              </div>
            </div>

            <TaxonomyPicker
              vendorId={taxonomy.vendorId}
              departmentId={taxonomy.departmentId}
              categoryId={taxonomy.categoryId}
              typeId={taxonomy.typeId}
              onChange={setTaxonomy}
            />
          </div>
        )}

        <div className="flex gap-3 pt-2 border-t border-sh-gray/10">
          {tab === "link" ? (
            <>
              <Button onClick={handleSave} disabled={saving} className="flex-1 min-h-[44px]">
                {saving ? "Saving…" : selectedProductId ? "Save Link" : "Unlink"}
              </Button>
              {item.productId && (
                <Button
                  onClick={() => {
                    setSelectedProductId(null);
                    setTimeout(handleSave, 0);
                  }}
                  disabled={saving}
                  className="min-h-[44px] px-4 bg-sh-gray hover:bg-sh-black"
                >
                  Clear Link
                </Button>
              )}
            </>
          ) : (
            <Button onClick={handleCreateAndLink} disabled={saving} className="flex-1 min-h-[44px]">
              {saving ? "Creating…" : "Create Product & Link"}
            </Button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-sh-gray/30 text-sh-gray text-sm min-h-[44px]"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
