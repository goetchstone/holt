"use client";

// /app/src/app/(dashboard)/app/reports/sales-by-salesperson/SalesBySalespersonView.tsx
//
// Sales by Salesperson — App Router + tRPC client view. Aggregated by
// salesperson, department, or customer for a date range, with retail / cost /
// margin and CSV export. Designers run it for their own data (the procedure
// enforces the role-based filter; the UI hides the salesperson picker for
// non-privileged roles).
//
// UX (ported verbatim from the Pages version):
//   - 3 KPI cards above the table
//   - summary auto-runs on filter change (tRPC useQuery keyed by the filters)
//   - sortable + sticky table header
//   - drilldown fetched imperatively per row, cached; hides the column matching
//     the active group-by
//   - SPLIT badge on split orders
//   - "Include delivery & freight" toggle (default off — labor stays included)
//   - CSV export stays a REST download (window.open) so the export route is
//     untouched during the migration
//
// See src/lib/reports/salesBySalespersonReport.ts for the data + role logic.

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { toast } from "react-toastify";
import { format, startOfMonth, subDays, endOfDay } from "date-fns";
import DateRangeFilter from "@/components/form/DateRangeFilter";
import MultiSelectDropdown from "@/components/form/MultiSelectDropdown";
import { KpiCard } from "@/components/report/KpiCard";
import { formatMarginPct } from "@/lib/marginMath";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { getErrorMessage } from "@/lib/toastError";
import { api } from "@/lib/trpc/client";
import type {
  GroupBy,
  SalesByGroupRow,
  SalesByGroupItem,
} from "@/lib/reports/salesBySalespersonReport";

interface StaffOption {
  id: number;
  displayName: string;
}

type SortKey = "groupLabel" | "itemCount" | "retail" | "cost" | "margin" | "marginPct";
type SortDir = "asc" | "desc";

// SUPER_ADMIN sees the same view ADMIN would (owner role above ADMIN).
const PRIVILEGED_ROLES = new Set(["SUPER_ADMIN", "ADMIN", "MANAGER", "MARKETING"]);

function groupHeaderLabel(groupBy: GroupBy): string {
  if (groupBy === "department") return "Department";
  if (groupBy === "customer") return "Customer";
  return "Salesperson";
}

/**
 * Build the REST querystring for the CSV export route, which still reads the
 * legacy query-param shape (comma-joined id/name lists, includeDeliveryFreight=1).
 */
function buildExportQuery(params: {
  startDate: string;
  endDate: string;
  groupBy: GroupBy;
  salesPersonIds: number[];
  departmentNames: string[];
  includeDeliveryFreight: boolean;
}): URLSearchParams {
  const q = new URLSearchParams();
  if (params.startDate) q.set("startDate", params.startDate);
  if (params.endDate) q.set("endDate", params.endDate);
  q.set("groupBy", params.groupBy);
  if (params.salesPersonIds.length > 0) q.set("salesPersonIds", params.salesPersonIds.join(","));
  if (params.departmentNames.length > 0) {
    q.set("departmentNames", params.departmentNames.join(","));
  }
  if (params.includeDeliveryFreight) q.set("includeDeliveryFreight", "1");
  return q;
}

/** Drilldown table row. Columns conditionally hide based on active group-by. */
function DrilldownRow({
  item,
  hideCol,
  fmt,
}: Readonly<{ item: SalesByGroupItem; hideCol: GroupBy; fmt: (v: number) => string }>) {
  return (
    <tr className="border-b border-sh-gray/10">
      <td className="py-1.5 pr-3">
        <Link href={`/app/sales/orders/${item.orderId}`} className="text-sh-blue hover:underline">
          {item.orderno}
        </Link>
        {item.isSplit && (
          <span
            title="50/50 split — half attribution to each partner"
            className="ml-1.5 px-1.5 py-0.5 text-[10px] font-semibold rounded bg-amber-100 text-amber-700 border border-amber-200 align-middle"
          >
            SPLIT
          </span>
        )}
      </td>
      <td className="py-1.5 pr-3 text-sh-gray">
        {item.orderDate ? item.orderDate.slice(0, 10) : "—"}
      </td>
      {hideCol !== "customer" && (
        <td className="py-1.5 pr-3 text-sh-black max-w-[180px] truncate">{item.customerLabel}</td>
      )}
      {hideCol !== "salesperson" && (
        <td className="py-1.5 pr-3 text-sh-gray max-w-[120px] truncate">
          {item.salesPersonName ?? "—"}
        </td>
      )}
      {hideCol !== "department" && (
        <td className="py-1.5 pr-3 text-sh-gray">{item.departmentName ?? "—"}</td>
      )}
      <td className="py-1.5 pr-3 text-sh-black max-w-[260px] truncate">
        {item.productName ?? item.partNo ?? "—"}
      </td>
      <td className="py-1.5 pr-3 text-right">{fmt(item.retail)}</td>
      <td className="py-1.5 pr-3 text-right text-sh-gray">{fmt(item.cost)}</td>
      <td className="py-1.5 pr-3 text-right">{fmt(item.margin)}</td>
      <td className="py-1.5 pr-3 text-right text-sh-gray">{formatMarginPct(item.marginPct)}</td>
    </tr>
  );
}

/** Body of an expanded drilldown row. Loading / empty / table — early returns. */
function DrilldownContent({
  isLoading,
  items,
  groupBy,
  fmt,
  onExport,
}: Readonly<{
  isLoading: boolean;
  items: SalesByGroupItem[] | undefined;
  groupBy: GroupBy;
  fmt: (v: number) => string;
  onExport: () => void;
}>) {
  if (isLoading) {
    return <p className="text-sm text-sh-gray">Loading line items…</p>;
  }
  if (!items || items.length === 0) {
    return <p className="text-sm text-sh-gray">No line items.</p>;
  }
  // Drilldown columns are conditional on the active group: when grouped
  // by salesperson, the Salesperson column is redundant (every row in
  // the drilldown is for that one person), so it's hidden. Same for
  // customer + department. Helper keeps the negated conditions out of
  // the spread (S7735).
  const showColumn = (columnGroup: GroupBy): boolean => groupBy !== columnGroup;
  const headerLabels: { key: string; label: string; align?: "right" }[] = [
    { key: "order", label: "Order" },
    { key: "date", label: "Date" },
    ...(showColumn("customer") ? [{ key: "customer", label: "Customer" }] : []),
    ...(showColumn("salesperson") ? [{ key: "salesperson", label: "Salesperson" }] : []),
    ...(showColumn("department") ? [{ key: "dept", label: "Dept" }] : []),
    { key: "item", label: "Item" },
    { key: "retail", label: "Retail", align: "right" },
    { key: "cost", label: "Cost", align: "right" },
    { key: "margin", label: "Margin", align: "right" },
    { key: "pct", label: "%", align: "right" },
  ];
  return (
    <>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs text-sh-gray">
          {items.length} line item{items.length === 1 ? "" : "s"}
          {items.length >= 500 && (
            <span className="text-amber-600">
              {" "}
              (showing first 500 — narrow filters to see more)
            </span>
          )}
        </p>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onExport();
          }}
          className="text-xs text-sh-blue hover:underline"
        >
          Export this drilldown
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-sh-gray border-b border-sh-gray/20">
              {headerLabels.map((h) => (
                <th
                  key={h.key}
                  className={`py-1.5 pr-3 ${h.align === "right" ? "text-right" : ""}`}
                >
                  {h.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <DrilldownRow key={it.lineItemId} item={it} hideCol={groupBy} fmt={fmt} />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Sortable column header with arrow indicator. */
function SortableTh({
  align,
  active,
  dir,
  onClick,
  children,
}: Readonly<{
  align?: "left" | "right";
  active: boolean;
  dir: SortDir;
  onClick: () => void;
  children: React.ReactNode;
}>) {
  let arrow = "▾";
  if (active) arrow = dir === "asc" ? "▲" : "▼";
  return (
    <th
      onClick={onClick}
      className={`p-3 font-semibold text-sh-black cursor-pointer select-none hover:bg-sh-stripe transition ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        <span
          className={`text-[10px] ${active ? "text-sh-blue" : "text-sh-gray/40"}`}
          aria-hidden="true"
        >
          {arrow}
        </span>
      </span>
    </th>
  );
}

export function SalesBySalespersonView() {
  const money = useMoneyFormatter();
  const fmt = (v: number) => money(v, { whole: true });
  const utils = api.useUtils();

  const { data: session } = useSession();
  const role = (session as { role?: string } | null)?.role;
  const isPrivileged = role !== undefined && PRIVILEGED_ROLES.has(role);

  const [dateRange, setDateRange] = useState({
    startDate: format(startOfMonth(subDays(new Date(), 30)), "yyyy-MM-dd"),
    endDate: format(endOfDay(new Date()), "yyyy-MM-dd"),
  });
  const [groupBy, setGroupBy] = useState<GroupBy>("salesperson");
  const [salesPersonIds, setSalesPersonIds] = useState<number[]>([]);
  const [departmentNames, setDepartmentNames] = useState<string[]>([]);
  const [includeDeliveryFreight, setIncludeDeliveryFreight] = useState(false);

  // Drilldown state
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [itemsByKey, setItemsByKey] = useState<Record<string, SalesByGroupItem[]>>({});
  const [itemsLoading, setItemsLoading] = useState<string | null>(null);

  // Sort state — default to retail descending (biggest first)
  const [sortKey, setSortKey] = useState<SortKey>("retail");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // Filter option lists
  const [staffOptions, setStaffOptions] = useState<StaffOption[]>([]);
  const [departmentOptions, setDepartmentOptions] = useState<string[]>([]);

  // Load filter options (staff list for privileged users; department list
  // always). These stay REST fetches per the migration convention — simple
  // option lists served by the existing /api/staff + /api/departments routes.
  useEffect(() => {
    if (isPrivileged) {
      fetch("/api/staff?isDesigner=true")
        .then((r) => r.json())
        .then((d: { staff?: StaffOption[] } | StaffOption[]) => {
          const list = Array.isArray(d) ? d : (d.staff ?? []);
          setStaffOptions(list);
        })
        .catch(() => setStaffOptions([]));
    }
    fetch("/api/departments?all=true")
      .then((r) => r.json())
      .then((d: { departments?: { name: string }[] } | { name: string }[]) => {
        const list = Array.isArray(d) ? d : (d.departments ?? []);
        setDepartmentOptions(list.map((x) => x.name).sort((a, b) => a.localeCompare(b)));
      })
      .catch(() => setDepartmentOptions([]));
  }, [isPrivileged]);

  const queryInput = useMemo(
    () => ({
      startDate: dateRange.startDate || undefined,
      endDate: dateRange.endDate || undefined,
      groupBy,
      salesPersonIds,
      departmentNames,
      includeDeliveryFreight,
    }),
    [dateRange, groupBy, salesPersonIds, departmentNames, includeDeliveryFreight],
  );

  // Summary auto-runs on any filter change — react-query keys by queryInput and
  // refetches when it changes, matching the legacy debounced auto-run.
  const query = api.reports.salesBySalesperson.useQuery(queryInput);
  const data = query.data ?? null;
  const loading = query.isFetching;

  // Any filter change shows a different report, so collapse open drilldowns and
  // drop their cached line items. Done in the change handlers (not an effect)
  // per React's set-state-in-effect guidance — mirrors SalespersonDetailView.
  function resetDrilldowns() {
    setExpandedKey(null);
    setItemsByKey({});
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  const sortedRows = useMemo(() => {
    if (!data?.rows) return [];
    const rows = [...data.rows];
    rows.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      let cmp = 0;
      if (typeof av === "string" && typeof bv === "string") {
        cmp = av.localeCompare(bv);
      } else {
        cmp = Number(av) - Number(bv);
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return rows;
  }, [data?.rows, sortKey, sortDir]);

  async function toggleDrilldown(row: SalesByGroupRow) {
    const key = row.groupKey;
    if (expandedKey === key) {
      setExpandedKey(null);
      return;
    }
    setExpandedKey(key);
    if (itemsByKey[key]) return; // cached
    setItemsLoading(key);
    try {
      const rows = await utils.reports.salesBySalespersonItems.fetch({
        ...queryInput,
        groupKey: key,
      });
      setItemsByKey((prev) => ({ ...prev, [key]: rows }));
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to load drilldown"));
      setExpandedKey(null);
    } finally {
      setItemsLoading(null);
    }
  }

  function exportCsv(level: "group" | "items", key?: string) {
    const q = buildExportQuery({
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
      groupBy,
      salesPersonIds,
      departmentNames,
      includeDeliveryFreight,
    });
    q.set("level", level);
    if (key) q.set("groupKey", key);
    window.open(`/api/reports/sales-by-salesperson/export?${q.toString()}`, "_blank");
  }

  const groupHeader = groupHeaderLabel(groupBy);

  const departmentMultiOptions = useMemo(
    () => departmentOptions.map((d) => ({ value: d, label: d })),
    [departmentOptions],
  );
  const staffMultiOptions = useMemo(
    () => staffOptions.map((s) => ({ value: String(s.id), label: s.displayName })),
    [staffOptions],
  );

  function renderResults() {
    if (loading && !data) {
      return <p className="text-sh-gray text-center py-8">Loading…</p>;
    }
    if (!data || data.rows.length === 0) {
      return (
        <p className="text-sh-gray text-center py-8">
          No sales data for this period and filter combination.
        </p>
      );
    }

    return (
      <>
        {/* KPI cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <KpiCard
            label="Total Retail"
            value={fmt(data.total.retail)}
            sub={`${data.total.itemCount.toLocaleString()} item${data.total.itemCount === 1 ? "" : "s"} · ${data.rows.length} ${groupHeader.toLowerCase()}${data.rows.length === 1 ? "" : "s"}`}
          />
          <KpiCard label="Total Margin" value={fmt(data.total.margin)} />
          <KpiCard label="Margin %" value={formatMarginPct(data.total.marginPct)} />
        </div>

        {/* Group-totals table */}
        <div className="bg-white border border-sh-gray/20 rounded-lg shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2 bg-sh-stripe border-b border-sh-gray/20">
            <p className="text-xs text-sh-gray">
              Click any {groupHeader.toLowerCase()} row to drill down
              {data.appliedFilters.includeDeliveryFreight && (
                <span className="ml-2 italic">· delivery &amp; freight included</span>
              )}
            </p>
            <button
              type="button"
              onClick={() => exportCsv("group")}
              className="text-xs text-sh-blue hover:underline"
            >
              Export CSV
            </button>
          </div>
          <div className="max-h-[70vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-sh-linen z-10 border-b border-sh-gray/20 shadow-sm">
                <tr>
                  <SortableTh
                    align="left"
                    active={sortKey === "groupLabel"}
                    dir={sortDir}
                    onClick={() => toggleSort("groupLabel")}
                  >
                    {groupHeader}
                  </SortableTh>
                  <SortableTh
                    align="right"
                    active={sortKey === "itemCount"}
                    dir={sortDir}
                    onClick={() => toggleSort("itemCount")}
                  >
                    Items
                  </SortableTh>
                  <SortableTh
                    align="right"
                    active={sortKey === "retail"}
                    dir={sortDir}
                    onClick={() => toggleSort("retail")}
                  >
                    Retail
                  </SortableTh>
                  <SortableTh
                    align="right"
                    active={sortKey === "cost"}
                    dir={sortDir}
                    onClick={() => toggleSort("cost")}
                  >
                    Cost
                  </SortableTh>
                  <SortableTh
                    align="right"
                    active={sortKey === "margin"}
                    dir={sortDir}
                    onClick={() => toggleSort("margin")}
                  >
                    Margin
                  </SortableTh>
                  <SortableTh
                    align="right"
                    active={sortKey === "marginPct"}
                    dir={sortDir}
                    onClick={() => toggleSort("marginPct")}
                  >
                    Margin %
                  </SortableTh>
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((row) => {
                  const isExpanded = expandedKey === row.groupKey;
                  const items = itemsByKey[row.groupKey];
                  const isLoading = itemsLoading === row.groupKey;
                  return (
                    <Fragment key={row.groupKey}>
                      <tr
                        onClick={() => toggleDrilldown(row)}
                        className={`border-b border-sh-gray/10 cursor-pointer transition ${
                          isExpanded ? "bg-sh-linen/60" : "hover:bg-sh-stripe"
                        }`}
                      >
                        <td className="p-3 font-medium">
                          <span className="inline-block w-4 text-sh-gray">
                            {isExpanded ? "▾" : "▸"}
                          </span>
                          {row.groupLabel}
                        </td>
                        <td className="p-3 text-right text-sh-gray">{row.itemCount}</td>
                        <td className="p-3 text-right font-medium">{fmt(row.retail)}</td>
                        <td className="p-3 text-right text-sh-gray">{fmt(row.cost)}</td>
                        <td className="p-3 text-right">{fmt(row.margin)}</td>
                        <td className="p-3 text-right text-sh-gray">
                          {formatMarginPct(row.marginPct)}
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr>
                          <td colSpan={6} className="bg-sh-linen/30 px-4 py-3">
                            <DrilldownContent
                              isLoading={isLoading}
                              items={items}
                              groupBy={groupBy}
                              fmt={fmt}
                              onExport={() => exportCsv("items", row.groupKey)}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="bg-sh-linen border-t-2 border-sh-gray/30 sticky bottom-0">
                  <td className="p-3 font-semibold">TOTAL</td>
                  <td className="p-3 text-right font-semibold">{data.total.itemCount}</td>
                  <td className="p-3 text-right font-semibold">{fmt(data.total.retail)}</td>
                  <td className="p-3 text-right font-semibold text-sh-gray">
                    {fmt(data.total.cost)}
                  </td>
                  <td className="p-3 text-right font-semibold">{fmt(data.total.margin)}</td>
                  <td className="p-3 text-right font-semibold text-sh-gray">
                    {formatMarginPct(data.total.marginPct)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </>
    );
  }

  return (
    <div className="max-w-screen-lg mx-auto py-6 space-y-4">
      <div className="flex items-baseline justify-between">
        <h1 className="font-serif text-2xl text-sh-black">Sales by Salesperson</h1>
        <Link href="/app/reports" className="text-sm text-sh-blue hover:underline">
          ← Back to reports
        </Link>
      </div>

      <p className="text-sm text-sh-gray">
        Date-range sales totals with retail, cost, and margin. Group by salesperson, department, or
        customer. Filter to a subset and export the result.
        {!isPrivileged && data?.appliedFilters?.designerLockedTo && (
          <>
            {" "}
            <span className="text-sh-blue">
              Showing your own data (<strong>{data.appliedFilters.designerLockedTo}</strong>).
            </span>
          </>
        )}
      </p>

      {/* Compact filter bar */}
      <div className="bg-white border border-sh-gray/20 rounded-lg shadow-sm p-4">
        <div className="flex items-end gap-3 flex-wrap">
          <div className="flex-1 min-w-[240px]">
            <DateRangeFilter
              value={dateRange}
              onChange={(v) => {
                setDateRange(v);
                resetDrilldowns();
              }}
            />
          </div>
          <fieldset>
            <legend className="block text-xs font-semibold text-sh-gray uppercase tracking-wide mb-1">
              Group by
            </legend>
            <div className="flex gap-1">
              {(["salesperson", "department", "customer"] as const).map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => {
                    setGroupBy(g);
                    resetDrilldowns();
                  }}
                  className={`px-3 py-2 text-sm rounded-lg border min-h-[42px] capitalize transition ${
                    groupBy === g
                      ? "bg-sh-blue text-white border-sh-blue"
                      : "bg-white text-sh-black border-sh-gray/30 hover:border-sh-blue"
                  }`}
                >
                  {g}
                </button>
              ))}
            </div>
          </fieldset>
          <div>
            <p className="block text-xs font-semibold text-sh-gray uppercase tracking-wide mb-1">
              Departments
            </p>
            <MultiSelectDropdown
              label="Departments"
              options={departmentMultiOptions}
              selected={departmentNames}
              onChange={(vals) => {
                setDepartmentNames(vals);
                resetDrilldowns();
              }}
              emptyLabel="All departments"
            />
          </div>
          {isPrivileged && (
            <div>
              <p className="block text-xs font-semibold text-sh-gray uppercase tracking-wide mb-1">
                Salespeople
              </p>
              <MultiSelectDropdown
                label="Salespeople"
                options={staffMultiOptions}
                selected={salesPersonIds.map(String)}
                onChange={(vals) => {
                  setSalesPersonIds(vals.map(Number));
                  resetDrilldowns();
                }}
                emptyLabel="All salespeople"
              />
            </div>
          )}
        </div>
        <div className="mt-3 pt-3 border-t border-sh-gray/15 flex items-center justify-between">
          <label className="inline-flex items-center gap-2 cursor-pointer text-sm">
            <input
              type="checkbox"
              checked={includeDeliveryFreight}
              onChange={(e) => {
                setIncludeDeliveryFreight(e.target.checked);
                resetDrilldowns();
              }}
              className="h-4 w-4 accent-sh-blue"
            />
            <span className="text-sh-black">Include delivery &amp; freight</span>
          </label>
          {loading && <span className="text-xs text-sh-gray italic">Updating…</span>}
        </div>
      </div>

      {/* Results */}
      {renderResults()}
    </div>
  );
}
