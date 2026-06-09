"use client";

// /app/src/app/(dashboard)/app/warehouse/inbound/InboundDashboardView.tsx
//
// Inbound POs body (open purchase orders by ESD, month/week drill-down with
// vendor/department/type filters). App Router port of the legacy
// pages/warehouse/inbound.tsx body (minus MainLayout chrome, which comes from
// the (dashboard) layout). Reads the shared /api/warehouse/inbound-dashboard
// REST endpoint.

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import axios from "axios";
import { Loader2, ChevronDown, ChevronRight } from "lucide-react";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import type { InboundPO } from "@/pages/api/warehouse/inbound-dashboard";

// --- Helpers ---

function formatDate(s: string | null) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function getMonthKey(dateStr: string): string {
  const d = new Date(dateStr);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function getMonthLabel(key: string): string {
  const [year, month] = key.split("-");
  const d = new Date(Number.parseInt(year), Number.parseInt(month) - 1);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long" });
}

function getWeekKey(dateStr: string): string {
  const d = new Date(dateStr);
  const day = d.getDay();
  const monday = new Date(d);
  monday.setDate(d.getDate() - ((day + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

function getWeekLabel(mondayStr: string): string {
  const monday = new Date(mondayStr);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `Week of ${fmt(monday)} - ${fmt(sunday)}`;
}

function AgeBadge({ days }: { days: number }) {
  if (days > 30)
    return (
      <span className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700">
        {days}d
      </span>
    );
  if (days > 14)
    return (
      <span className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-700">
        {days}d
      </span>
    );
  return (
    <span className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-700">
      {days}d
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    DRAFT: "bg-gray-100 text-sh-gray",
    SUBMITTED: "bg-sh-blue/10 text-sh-blue",
    CONFIRMED: "bg-green-100 text-green-700",
    RECEIVED_PARTIAL: "bg-amber-100 text-amber-700",
  };
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${colors[status] || "bg-gray-100 text-sh-gray"}`}
    >
      {status.replace("_", " ")}
    </span>
  );
}

// --- Filter types ---

type FilterType = "all" | "overdue" | "thisWeek" | "nextWeek" | "noEsd" | "hasEsd";

// --- Component ---

type OrderTypeFilter = "all" | "stock" | "customer";

export function InboundDashboardView() {
  const formatCurrency = useMoneyFormatter();
  const [allPOs, setAllPOs] = useState<InboundPO[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterType>("all");
  const [orderTypeFilter, setOrderTypeFilter] = useState<OrderTypeFilter>("all");
  const [vendorFilter, setVendorFilter] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [vendors, setVendors] = useState<string[]>([]);
  const [departments, setDepartments] = useState<string[]>([]);
  const [expandedMonths, setExpandedMonths] = useState<Set<string>>(new Set());
  const [expandedWeeks, setExpandedWeeks] = useState<Set<string>>(new Set());

  useEffect(() => {
    axios
      .get<{ items: InboundPO[]; vendors: string[]; departments: string[] }>(
        "/api/warehouse/inbound-dashboard",
      )
      .then((r) => {
        setAllPOs(r.data.items);
        setVendors(r.data.vendors);
        setDepartments(r.data.departments);
      })
      .finally(() => setLoading(false));
  }, []);

  // Compute summary counts
  const now = useMemo(() => new Date(), []);
  const startOfToday = useMemo(
    () => new Date(now.getFullYear(), now.getMonth(), now.getDate()),
    [now],
  );

  const summary = useMemo(() => {
    const sevenDays = new Date(startOfToday.getTime() + 7 * 86400000);
    const fourteenDays = new Date(startOfToday.getTime() + 14 * 86400000);
    const sevenAgo = new Date(startOfToday.getTime() - 7 * 86400000);

    let overdue = 0;
    let thisWeek = 0;
    let nextWeek = 0;
    let noEsd = 0;
    let hasEsd = 0;

    for (const po of allPOs) {
      if (!po.expectedDelivery) {
        if (new Date(po.orderDate) < sevenAgo) noEsd++;
        continue;
      }
      hasEsd++;
      const esd = new Date(po.expectedDelivery);
      if (esd < startOfToday) overdue++;
      else if (esd < sevenDays) thisWeek++;
      else if (esd < fourteenDays) nextWeek++;
    }

    return { total: allPOs.length, overdue, thisWeek, nextWeek, noEsd, hasEsd };
  }, [allPOs, startOfToday]);

  // Apply all filters
  const filteredPOs = useMemo(() => {
    const sevenDays = new Date(startOfToday.getTime() + 7 * 86400000);
    const fourteenDays = new Date(startOfToday.getTime() + 14 * 86400000);
    const sevenAgo = new Date(startOfToday.getTime() - 7 * 86400000);

    return allPOs.filter((po) => {
      // Time filter
      if (filter === "noEsd" && (po.expectedDelivery || new Date(po.orderDate) >= sevenAgo))
        return false;
      if (filter !== "all" && filter !== "noEsd") {
        if (!po.expectedDelivery) return false;
        const esd = new Date(po.expectedDelivery);
        if (filter === "overdue" && esd >= startOfToday) return false;
        if (filter === "thisWeek" && (esd < startOfToday || esd >= sevenDays)) return false;
        if (filter === "nextWeek" && (esd < sevenDays || esd >= fourteenDays)) return false;
      }
      // Order type
      if (orderTypeFilter === "stock" && po.orderType !== "stock") return false;
      if (orderTypeFilter === "customer" && po.orderType !== "customer") return false;
      // Vendor
      if (vendorFilter && po.vendorName !== vendorFilter) return false;
      // Department
      if (departmentFilter && !po.departments.includes(departmentFilter)) return false;
      return true;
    });
  }, [allPOs, filter, orderTypeFilter, vendorFilter, departmentFilter, startOfToday]);

  // Group by month -> week
  const monthGroups = useMemo(() => {
    const withEsd = filteredPOs.filter((po) => po.expectedDelivery);
    const withoutEsd = filteredPOs.filter((po) => !po.expectedDelivery);

    const byMonth = new Map<string, InboundPO[]>();
    for (const po of withEsd) {
      const key = getMonthKey(po.expectedDelivery!);
      if (!byMonth.has(key)) byMonth.set(key, []);
      byMonth.get(key)!.push(po);
    }

    const sorted = [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    return { months: sorted, noEsd: withoutEsd };
  }, [filteredPOs]);

  function getWeeksForMonth(pos: InboundPO[]) {
    const byWeek = new Map<string, InboundPO[]>();
    for (const po of pos) {
      const key = getWeekKey(po.expectedDelivery!);
      if (!byWeek.has(key)) byWeek.set(key, []);
      byWeek.get(key)!.push(po);
    }
    return [...byWeek.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }

  function toggleMonth(key: string) {
    setExpandedMonths((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleWeek(key: string) {
    setExpandedWeeks((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // Start collapsed — let the user drill into what they need
  useEffect(() => {
    setExpandedMonths(new Set());
    setExpandedWeeks(new Set());
  }, [allPOs]);

  const filterLabel: Record<FilterType, string> = {
    all: "All",
    overdue: "Overdue",
    thisWeek: "This Week",
    nextWeek: "Next Week",
    noEsd: "No ESD",
    hasEsd: "Has ESD",
  };

  return (
    <div className="py-2 space-y-5 font-serif">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Link href="/app/warehouse" className="text-sh-blue hover:underline text-sm">
            Warehouse
          </Link>
          <span className="text-sh-gray">/</span>
          <h1 className="text-2xl font-semibold text-sh-blue">Inbound</h1>
          {filter !== "all" && (
            <span className="text-sm text-sh-gray">
              — {filterLabel[filter]} ({filteredPOs.length})
            </span>
          )}
        </div>
        <div className="flex gap-2">
          {filter !== "all" && (
            <button
              onClick={() => setFilter("all")}
              className="px-4 py-2 text-sm font-semibold border border-sh-navy text-sh-navy rounded-lg hover:bg-sh-linen transition min-h-[44px]"
            >
              Clear Filter
            </button>
          )}
          <Link href="/app/warehouse/outbound">
            <span className="px-4 py-2 text-sm font-semibold border border-sh-navy text-sh-navy rounded-lg hover:bg-sh-linen transition min-h-[44px] flex items-center cursor-pointer">
              Outbound
            </span>
          </Link>
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-sh-blue mr-3" />
          <span className="text-sh-gray">Loading purchase orders...</span>
        </div>
      )}

      {/* Summary cards — clickable */}
      {!loading && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <button
            onClick={() => setFilter("all")}
            className={`bg-white rounded-xl border p-4 text-center transition min-h-[44px] ${
              filter === "all"
                ? "border-sh-blue ring-2 ring-sh-blue/20"
                : "border-sh-gray/15 hover:border-sh-blue/30"
            }`}
          >
            <div className="text-xs text-sh-gray mb-1">Total Open</div>
            <div className="text-2xl font-semibold text-sh-black">{summary.total}</div>
          </button>
          <button
            onClick={() => setFilter("thisWeek")}
            className={`bg-white rounded-xl border p-4 text-center transition min-h-[44px] ${
              filter === "thisWeek"
                ? "border-sh-blue ring-2 ring-sh-blue/20"
                : "border-sh-gray/15 hover:border-sh-blue/30"
            }`}
          >
            <div className="text-xs text-sh-gray mb-1">Due This Week</div>
            <div className="text-2xl font-semibold text-sh-black">{summary.thisWeek}</div>
          </button>
          <button
            onClick={() => setFilter("nextWeek")}
            className={`bg-white rounded-xl border p-4 text-center transition min-h-[44px] ${
              filter === "nextWeek"
                ? "border-sh-blue ring-2 ring-sh-blue/20"
                : "border-sh-gray/15 hover:border-sh-blue/30"
            }`}
          >
            <div className="text-xs text-sh-gray mb-1">Due Next Week</div>
            <div className="text-2xl font-semibold text-sh-black">{summary.nextWeek}</div>
          </button>
          <button
            onClick={() => setFilter("noEsd")}
            className={`bg-white rounded-xl border p-4 text-center transition min-h-[44px] ${
              filter === "noEsd"
                ? "border-red-500 ring-2 ring-red-200"
                : summary.noEsd > 0
                  ? "border-red-200 hover:border-red-400"
                  : "border-sh-gray/15 hover:border-sh-blue/30"
            }`}
          >
            <div className="text-xs text-sh-gray mb-1">Missing ESD</div>
            <div
              className={`text-2xl font-semibold ${summary.noEsd > 0 ? "text-red-600" : "text-sh-black"}`}
            >
              {summary.noEsd}
            </div>
          </button>
          <button
            onClick={() => setFilter("overdue")}
            className={`bg-white rounded-xl border p-4 text-center transition min-h-[44px] ${
              filter === "overdue"
                ? "border-red-500 ring-2 ring-red-200"
                : summary.overdue > 0
                  ? "border-red-200 hover:border-red-400"
                  : "border-sh-gray/15 hover:border-sh-blue/30"
            }`}
          >
            <div className="text-xs text-sh-gray mb-1">Overdue</div>
            <div
              className={`text-2xl font-semibold ${summary.overdue > 0 ? "text-red-600" : "text-sh-black"}`}
            >
              {summary.overdue}
            </div>
          </button>
        </div>
      )}

      {/* Filter bar */}
      {!loading && (
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="inbound-type-filter" className="block text-xs text-sh-gray mb-1">
              Type
            </label>
            <select
              id="inbound-type-filter"
              value={orderTypeFilter}
              onChange={(e) => setOrderTypeFilter(e.target.value as OrderTypeFilter)}
              className="border border-sh-gray/40 rounded-lg px-3 min-h-[44px] text-sm bg-white"
            >
              <option value="all">All Orders</option>
              <option value="stock">Stock Only</option>
              <option value="customer">Customer Orders</option>
            </select>
          </div>
          <div>
            <label htmlFor="inbound-vendor-filter" className="block text-xs text-sh-gray mb-1">
              Vendor
            </label>
            <select
              id="inbound-vendor-filter"
              value={vendorFilter}
              onChange={(e) => setVendorFilter(e.target.value)}
              className="border border-sh-gray/40 rounded-lg px-3 min-h-[44px] text-sm bg-white"
            >
              <option value="">All Vendors</option>
              {vendors.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="inbound-department-filter" className="block text-xs text-sh-gray mb-1">
              Department
            </label>
            <select
              id="inbound-department-filter"
              value={departmentFilter}
              onChange={(e) => setDepartmentFilter(e.target.value)}
              className="border border-sh-gray/40 rounded-lg px-3 min-h-[44px] text-sm bg-white"
            >
              <option value="">All Departments</option>
              {departments.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
          {(orderTypeFilter !== "all" || vendorFilter || departmentFilter) && (
            <button
              onClick={() => {
                setOrderTypeFilter("all");
                setVendorFilter("");
                setDepartmentFilter("");
              }}
              className="text-sm text-sh-blue hover:underline min-h-[44px] flex items-center"
            >
              Clear filters
            </button>
          )}
          <span className="text-sm text-sh-gray ml-auto">
            {filteredPOs.length} of {allPOs.length} POs
          </span>
        </div>
      )}

      {/* Month groups */}
      {!loading && (
        <div className="space-y-3">
          {monthGroups.months.map(([monthKey, monthPOs]) => {
            const isExpanded = expandedMonths.has(monthKey);
            const weeks = getWeeksForMonth(monthPOs);
            const monthCost = monthPOs.reduce((s, p) => s + p.totalCost, 0);

            return (
              <div
                key={monthKey}
                className="bg-white rounded-xl border border-sh-gray/15 overflow-hidden"
              >
                {/* Month header */}
                <button
                  onClick={() => toggleMonth(monthKey)}
                  className="w-full flex items-center justify-between px-5 py-4 hover:bg-sh-linen/50 transition min-h-[44px]"
                >
                  <div className="flex items-center gap-3">
                    {isExpanded ? (
                      <ChevronDown className="w-5 h-5 text-sh-gray" />
                    ) : (
                      <ChevronRight className="w-5 h-5 text-sh-gray" />
                    )}
                    <span className="text-lg font-semibold text-sh-blue">
                      {getMonthLabel(monthKey)}
                    </span>
                    <span className="text-sm text-sh-gray">
                      {monthPOs.length} PO{monthPOs.length !== 1 ? "s" : ""}
                    </span>
                  </div>
                  <span className="text-sm font-semibold text-sh-black">
                    {formatCurrency(monthCost)}
                  </span>
                </button>

                {/* Weeks within month */}
                {isExpanded && (
                  <div className="border-t border-sh-gray/10">
                    {weeks.map(([weekKey, weekPOs]) => {
                      const isWeekExpanded = expandedWeeks.has(weekKey);

                      return (
                        <div key={weekKey} className="border-b border-sh-gray/10 last:border-0">
                          {/* Week header */}
                          <button
                            onClick={() => toggleWeek(weekKey)}
                            className="w-full flex items-center justify-between px-8 py-3 hover:bg-sh-linen/30 transition min-h-[44px]"
                          >
                            <div className="flex items-center gap-3">
                              {isWeekExpanded ? (
                                <ChevronDown className="w-4 h-4 text-sh-gray" />
                              ) : (
                                <ChevronRight className="w-4 h-4 text-sh-gray" />
                              )}
                              <span className="font-semibold text-sh-black">
                                {getWeekLabel(weekKey)}
                              </span>
                              <span className="text-sm text-sh-gray">
                                {weekPOs.length} PO{weekPOs.length !== 1 ? "s" : ""}
                              </span>
                            </div>
                            <span className="text-sm text-sh-gray">
                              {formatCurrency(weekPOs.reduce((s, p) => s + p.totalCost, 0))}
                            </span>
                          </button>

                          {/* PO rows */}
                          {isWeekExpanded && (
                            <table className="w-full text-sm">
                              <thead>
                                <tr className="bg-sh-linen border-b border-sh-gray/10">
                                  <th className="text-left px-8 py-2 text-sh-gray font-semibold">
                                    PO #
                                  </th>
                                  <th className="text-left px-4 py-2 text-sh-gray font-semibold">
                                    Vendor
                                  </th>
                                  <th className="text-left px-4 py-2 text-sh-gray font-semibold">
                                    Type / Customer
                                  </th>
                                  <th className="text-left px-4 py-2 text-sh-gray font-semibold">
                                    ESD
                                  </th>
                                  <th className="text-left px-4 py-2 text-sh-gray font-semibold">
                                    Status
                                  </th>
                                  <th className="text-right px-4 py-2 text-sh-gray font-semibold">
                                    Items
                                  </th>
                                  <th className="text-right px-4 py-2 text-sh-gray font-semibold">
                                    Cost
                                  </th>
                                  <th className="text-left px-4 py-2 text-sh-gray font-semibold">
                                    Age
                                  </th>
                                </tr>
                              </thead>
                              <tbody>
                                {weekPOs.map((po, i) => (
                                  <tr
                                    key={po.id}
                                    className={`border-b border-sh-gray/10 last:border-0 ${i % 2 === 1 ? "bg-sh-stripe" : ""}`}
                                  >
                                    <td className="px-8 py-3">
                                      <Link
                                        href={`/app/purchasing/orders/${po.id}`}
                                        className="text-sh-blue hover:underline font-mono text-xs min-h-[44px] flex items-center"
                                      >
                                        {po.poNumber}
                                      </Link>
                                    </td>
                                    <td className="px-4 py-3 text-sh-black text-xs">
                                      {po.vendorName}
                                    </td>
                                    <td className="px-4 py-3 text-xs">
                                      {po.orderType === "customer" ? (
                                        <span>
                                          <span className="inline-block px-1.5 py-0.5 rounded bg-sh-gold/20 text-sh-gold text-xs font-semibold mr-1">
                                            Customer
                                          </span>
                                          {po.salesOrderId ? (
                                            <Link
                                              href={`/app/sales/orders/${po.salesOrderId}`}
                                              className="text-sh-blue hover:underline"
                                            >
                                              {po.customerName || po.orderno}
                                            </Link>
                                          ) : (
                                            <span className="text-sh-gray">
                                              {po.customerName || "—"}
                                            </span>
                                          )}
                                        </span>
                                      ) : (
                                        <span className="inline-block px-1.5 py-0.5 rounded bg-sh-blue/10 text-sh-blue text-xs font-semibold">
                                          Stock
                                        </span>
                                      )}
                                    </td>
                                    <td className="px-4 py-3 text-sh-black text-xs">
                                      {formatDate(po.expectedDelivery)}
                                    </td>
                                    <td className="px-4 py-3">
                                      <StatusBadge status={po.status} />
                                    </td>
                                    <td className="px-4 py-3 text-right text-sh-black">
                                      {po.lineItemCount}
                                    </td>
                                    <td className="px-4 py-3 text-right text-sh-black text-xs">
                                      {formatCurrency(po.totalCost)}
                                    </td>
                                    <td className="px-4 py-3">
                                      <AgeBadge days={po.ageInDays} />
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}

          {/* No ESD section */}
          {monthGroups.noEsd.length > 0 && (
            <div className="bg-white rounded-xl border border-red-200 overflow-hidden">
              <button
                onClick={() => toggleMonth("no-esd")}
                className="w-full flex items-center justify-between px-5 py-4 hover:bg-red-50/50 transition min-h-[44px]"
              >
                <div className="flex items-center gap-3">
                  {expandedMonths.has("no-esd") ? (
                    <ChevronDown className="w-5 h-5 text-red-600" />
                  ) : (
                    <ChevronRight className="w-5 h-5 text-red-600" />
                  )}
                  <span className="text-lg font-semibold text-red-700">Missing ESD</span>
                  <span className="text-sm text-red-600">
                    {monthGroups.noEsd.length} PO{monthGroups.noEsd.length !== 1 ? "s" : ""} older
                    than 7 days
                  </span>
                </div>
              </button>

              {expandedMonths.has("no-esd") && (
                <table className="w-full text-sm border-t border-red-100">
                  <thead>
                    <tr className="bg-red-50 border-b border-red-100">
                      <th className="text-left px-5 py-2 text-sh-gray font-semibold">PO #</th>
                      <th className="text-left px-4 py-2 text-sh-gray font-semibold">Vendor</th>
                      <th className="text-left px-4 py-2 text-sh-gray font-semibold">Order Date</th>
                      <th className="text-left px-4 py-2 text-sh-gray font-semibold">Status</th>
                      <th className="text-right px-4 py-2 text-sh-gray font-semibold">Items</th>
                      <th className="text-left px-4 py-2 text-sh-gray font-semibold">Age</th>
                    </tr>
                  </thead>
                  <tbody>
                    {monthGroups.noEsd.map((po, i) => (
                      <tr
                        key={po.id}
                        className={`border-b border-red-100 last:border-0 ${i % 2 === 1 ? "bg-red-50/30" : ""}`}
                      >
                        <td className="px-5 py-3">
                          <Link
                            href={`/app/purchasing/orders/${po.id}`}
                            className="text-sh-blue hover:underline font-mono text-xs min-h-[44px] flex items-center"
                          >
                            {po.poNumber}
                          </Link>
                        </td>
                        <td className="px-4 py-3 text-sh-black text-xs">{po.vendorName}</td>
                        <td className="px-4 py-3 text-sh-black text-xs">
                          {formatDate(po.orderDate)}
                        </td>
                        <td className="px-4 py-3">
                          <StatusBadge status={po.status} />
                        </td>
                        <td className="px-4 py-3 text-right text-sh-black">{po.lineItemCount}</td>
                        <td className="px-4 py-3">
                          <AgeBadge days={po.ageInDays} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* Empty state */}
          {!loading && filteredPOs.length === 0 && (
            <div className="text-center py-16 text-sh-gray">
              {filter === "all"
                ? "No open purchase orders."
                : `No purchase orders matching "${filterLabel[filter]}" filter.`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
