"use client";

// /app/src/app/(dashboard)/app/reports/customers/CustomersReportView.tsx
//
// Customer directory report. Search + group filters + has-phone + server-side
// pagination, all via tRPC. Committed filters drive the query key so paging and
// filtering refetch cleanly. ADMIN/MARKETING; the page gated server-side.

import { useState } from "react";
import { KpiCard, ReportSection, ReportTable } from "@/components/report";
import type { ReportColumn } from "@/components/report";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { api } from "@/lib/trpc/client";
import type { CustomerReportRow } from "@/lib/reports/customersReport";

const PAGE_SIZE = 50;

const LEVEL_LABELS: Record<number, string> = {
  1: "Occasional",
  2: "Frequent",
  3: "High Value",
  4: "VIP",
};

const GROUP_OPTIONS: { id: string; label: string }[] = [
  { id: "FURNITURE", label: "Furniture" },
  { id: "HOME_ACC", label: "Home Accessories" },
  { id: "APPAREL", label: "Apparel" },
  { id: "CHRISTMAS", label: "Christmas" },
];

function groupLabel(g: string | null): string {
  if (!g) return "—";
  const opt = GROUP_OPTIONS.find((o) => o.id === g);
  if (opt) return opt.label;
  if (g === "HOME") return "Home (legacy)";
  if (g === "LIFESTYLE") return "Lifestyle (legacy)";
  return g;
}

export function CustomersReportView() {
  const money = useMoneyFormatter();
  const currency = (v: number) => money(v, { whole: true });

  const [search, setSearch] = useState("");
  const [hasPhone, setHasPhone] = useState(false);
  const [selectedGroups, setSelectedGroups] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  // Committed filters — search/group/phone changes apply on "Search"; paging
  // applies immediately.
  const [committed, setCommitted] = useState({
    search: "",
    hasPhone: false,
    groups: [] as string[],
  });

  const query = api.reports.customers.useQuery({
    search: committed.search || undefined,
    hasPhone: committed.hasPhone,
    groups: committed.groups,
    page,
    limit: PAGE_SIZE,
  });
  const data = query.data;
  const loading = query.isFetching;

  const columns: ReportColumn<CustomerReportRow>[] = [
    {
      key: "lastName",
      label: "Customer",
      sortable: true,
      format: (row) => {
        const name = [row.firstName, row.lastName].filter(Boolean).join(" ") || "(no name)";
        return row.isTradeAccount ? `${name} [Trade]` : name;
      },
    },
    { key: "phone", label: "Phone", sortable: true, format: (row) => row.phone ?? "—" },
    { key: "email", label: "Email", sortable: true, format: (row) => row.email ?? "—" },
    {
      key: "primaryDesigner",
      label: "Designer",
      sortable: true,
      format: (row) => row.primaryDesigner ?? "—",
    },
    {
      key: "customerLevel",
      label: "Level",
      sortable: true,
      format: (row) => {
        if (!row.customerLevel && row.peakCustomerLevel) return "Dormant";
        return LEVEL_LABELS[row.customerLevel ?? 0] ?? "—";
      },
    },
    {
      key: "customerGroup",
      label: "Primary Group",
      sortable: true,
      format: (row) => groupLabel(row.customerGroup),
      csvFormat: (row) => groupLabel(row.customerGroup),
    },
    { key: "orderCount", label: "Orders", align: "right", sortable: true },
    {
      key: "totalSpend",
      label: "Total Spend",
      align: "right",
      sortable: true,
      format: (row) => currency(row.totalSpend),
      csvFormat: (row) => row.totalSpend,
    },
    {
      key: "lastOrderDate",
      label: "Last Order",
      sortable: true,
      format: (row) => row.lastOrderDate ?? "—",
    },
  ];

  function toggleGroup(id: string) {
    setSelectedGroups((prev) => (prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id]));
  }

  function applyFilters() {
    setPage(1);
    setCommitted({ search, hasPhone, groups: selectedGroups });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") applyFilters();
  }

  const rows = data?.customers ?? [];
  const totalRows = data?.total ?? 0;
  const totalPages = Math.ceil(totalRows / PAGE_SIZE) || 1;
  const stats = data?.stats;

  return (
    <div className="space-y-8 font-serif">
      <div>
        <h1 className="text-2xl font-semibold text-sh-black">Customer Report</h1>
        <p className="mt-1 font-sans text-xs text-sh-gray">
          Contact list with order history, spend totals, and customer levels
        </p>
      </div>

      <div className="space-y-4 rounded-xl border border-sh-gray/15 bg-white p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <label
              htmlFor="cust-search"
              className="mb-1 block font-sans text-xs font-semibold uppercase tracking-wider text-sh-gray"
            >
              Search
            </label>
            <input
              id="cust-search"
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Name, email, or phone"
              className="min-h-[44px] w-full rounded-lg border border-sh-gray/30 px-3 py-2 font-sans text-sm text-sh-black focus:border-sh-blue focus:outline-none"
            />
          </div>
          <div className="flex min-h-[44px] items-center gap-2">
            <input
              id="hasPhone"
              type="checkbox"
              checked={hasPhone}
              onChange={(e) => setHasPhone(e.target.checked)}
              className="h-4 w-4 accent-sh-blue"
            />
            <label
              htmlFor="hasPhone"
              className="cursor-pointer select-none font-sans text-sm text-sh-black"
            >
              Has phone only
            </label>
          </div>
          <button
            type="button"
            onClick={applyFilters}
            disabled={loading}
            className="min-h-[44px] rounded-lg bg-sh-navy px-5 py-2 font-sans text-sm font-semibold text-white transition-colors hover:bg-sh-blue disabled:opacity-50"
          >
            {loading ? "Loading..." : "Search"}
          </button>
        </div>

        <div>
          <label className="mb-2 block font-sans text-xs font-semibold uppercase tracking-wider text-sh-gray">
            Primary Group
          </label>
          <div className="flex flex-wrap gap-2">
            {GROUP_OPTIONS.map((opt) => {
              const active = selectedGroups.includes(opt.id);
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => toggleGroup(opt.id)}
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
            {selectedGroups.length > 0 && (
              <button
                type="button"
                onClick={() => setSelectedGroups([])}
                className="rounded-full px-3 py-1.5 text-xs text-sh-gray underline hover:text-sh-black"
              >
                Clear
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Total Customers" value={loading ? "—" : (stats?.totalCustomers ?? 0)} />
        <KpiCard label="With Phone" value={loading ? "—" : (stats?.withPhone ?? 0)} />
        <KpiCard label="With Email" value={loading ? "—" : (stats?.withEmail ?? 0)} />
        <KpiCard label="Trade Accounts" value={loading ? "—" : (stats?.tradeAccounts ?? 0)} />
      </div>

      <ReportSection
        title="Customers"
        description={`${totalRows.toLocaleString()} customers — page ${page} of ${totalPages}`}
      >
        <ReportTable<CustomerReportRow>
          columns={columns}
          rows={rows}
          getRowKey={(row) => row.id}
          exportFilename="customer-report"
          emptyMessage={loading ? "Loading..." : "No customers found."}
        />

        {totalPages > 1 && (
          <div className="mt-4 flex items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1 || loading}
              className="min-h-[44px] rounded-lg border border-sh-gray/20 px-3 py-2 text-sm hover:bg-sh-linen disabled:opacity-30"
            >
              Previous
            </button>
            <span className="text-sm text-sh-gray">
              Page {page} of {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages || loading}
              className="min-h-[44px] rounded-lg border border-sh-gray/20 px-3 py-2 text-sm hover:bg-sh-linen disabled:opacity-30"
            >
              Next
            </button>
          </div>
        )}
      </ReportSection>
    </div>
  );
}
