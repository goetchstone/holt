"use client";

// /app/src/app/(dashboard)/app/admin/sales/salesperson-corrections/SalespersonCorrectionsView.tsx
//
// Salesperson corrections body. App Router port of the legacy
// admin/sales/salesperson-corrections page (minus MainLayout chrome, supplied by
// the (dashboard) layout). Search orders, multi-select, bulk-reassign primary +
// split salesperson. Talks to the shared /api/sales/orders + /api/staff +
// /api/admin/sales/bulk-update-salesperson REST endpoints.

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { Loader2, UserCog } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";

interface StaffOption {
  id: number;
  displayName: string;
}

interface OrderRow {
  id: number;
  orderno: string;
  orderDate: string | null;
  salesperson: string | null;
  salesPersonId: number | null;
  splitWithId: number | null;
  storeLocation: string | null;
  customer: { firstName: string | null; lastName: string | null } | null;
  status: string;
  selected: boolean;
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function SalespersonCorrectionsView() {
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Filters
  const [filterOrderno, setFilterOrderno] = useState("");
  const [filterSalesperson, setFilterSalesperson] = useState("");
  const [filterStore, setFilterStore] = useState("");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");

  // Bulk assignment
  const [bulkPrimary, setBulkPrimary] = useState<number | "">("");
  const [bulkSplit, setBulkSplit] = useState<number | "" | "clear">("");

  useEffect(() => {
    axios
      .get("/api/staff?all=true")
      .then((res) => {
        const list = (res.data.staff || res.data || []).map(
          (s: { id: number; displayName: string }) => ({
            id: s.id,
            displayName: s.displayName,
          }),
        );
        setStaff(list);
      })
      .catch(() => {});
  }, []);

  const searchOrders = useCallback(async () => {
    if (!filterOrderno && !filterSalesperson && !filterStore && !filterDateFrom) {
      toast.warn("Select at least one filter before searching.");
      return;
    }
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterOrderno) params.set("search", filterOrderno);
      if (filterSalesperson) params.set("salesperson", filterSalesperson);
      if (filterStore) params.set("store", filterStore);
      if (filterDateFrom) params.set("from", filterDateFrom);
      if (filterDateTo) params.set("to", filterDateTo);
      params.set("limit", "500");

      const res = await axios.get(`/api/sales/orders?${params.toString()}`);
      const data = res.data.orders || res.data || [];
      setOrders(
        data.map((o: OrderRow) => ({
          ...o,
          selected: false,
        })),
      );
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to load orders."));
    } finally {
      setLoading(false);
    }
  }, [filterOrderno, filterSalesperson, filterStore, filterDateFrom, filterDateTo]);

  const toggleSelect = (id: number) => {
    setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, selected: !o.selected } : o)));
  };

  const toggleAll = () => {
    const allSelected = orders.every((o) => o.selected);
    setOrders((prev) => prev.map((o) => ({ ...o, selected: !allSelected })));
  };

  const selectedOrders = orders.filter((o) => o.selected);

  const handleBulkUpdate = async () => {
    if (selectedOrders.length === 0) {
      toast.warn("No orders selected.");
      return;
    }
    if (bulkPrimary === "") {
      toast.warn("Select a salesperson to assign.");
      return;
    }

    setSaving(true);
    try {
      const resolveSplit = () => {
        if (bulkSplit === "clear") return null;
        if (bulkSplit === "") return undefined;
        return bulkSplit;
      };
      const updates = selectedOrders.map((o) => ({
        orderId: o.id,
        salesPersonId: bulkPrimary as number,
        splitWithId: resolveSplit(),
      }));

      const res = await axios.post("/api/admin/sales/bulk-update-salesperson", { updates });
      const { updated, errors } = res.data;
      toast.success(
        `Updated ${updated} order(s).${errors?.length ? ` ${errors.length} failed.` : ""}`,
      );
      searchOrders();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Bulk update failed."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-serif text-sh-navy">Salesperson Corrections</h1>

      <SearchFilters
        filterOrderno={filterOrderno}
        filterSalesperson={filterSalesperson}
        filterStore={filterStore}
        filterDateFrom={filterDateFrom}
        filterDateTo={filterDateTo}
        loading={loading}
        setFilterOrderno={setFilterOrderno}
        setFilterSalesperson={setFilterSalesperson}
        setFilterStore={setFilterStore}
        setFilterDateFrom={setFilterDateFrom}
        setFilterDateTo={setFilterDateTo}
        onSearch={searchOrders}
      />

      {orders.length > 0 && (
        <BulkAssignControls
          staff={staff}
          selectedCount={selectedOrders.length}
          bulkPrimary={bulkPrimary}
          bulkSplit={bulkSplit}
          saving={saving}
          setBulkPrimary={setBulkPrimary}
          setBulkSplit={setBulkSplit}
          onApply={handleBulkUpdate}
        />
      )}

      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-sh-gold" />
        </div>
      )}

      {!loading && orders.length > 0 && (
        <OrdersTable
          orders={orders}
          staff={staff}
          onToggleSelect={toggleSelect}
          onToggleAll={toggleAll}
        />
      )}

      {!loading && orders.length === 0 && filterSalesperson && (
        <p className="text-center text-sm text-sh-gray py-8">
          No orders found. Try adjusting your filters.
        </p>
      )}
    </div>
  );
}

interface SearchFiltersProps {
  filterOrderno: string;
  filterSalesperson: string;
  filterStore: string;
  filterDateFrom: string;
  filterDateTo: string;
  loading: boolean;
  setFilterOrderno: (s: string) => void;
  setFilterSalesperson: (s: string) => void;
  setFilterStore: (s: string) => void;
  setFilterDateFrom: (s: string) => void;
  setFilterDateTo: (s: string) => void;
  onSearch: () => void;
}

function SearchFilters({
  filterOrderno,
  filterSalesperson,
  filterStore,
  filterDateFrom,
  filterDateTo,
  loading,
  setFilterOrderno,
  setFilterSalesperson,
  setFilterStore,
  setFilterDateFrom,
  setFilterDateTo,
  onSearch,
}: Readonly<SearchFiltersProps>) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5 space-y-4">
      <h2 className="text-sm font-semibold text-sh-navy">Search Orders</h2>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
        <div>
          <label htmlFor="filter-orderno" className="block text-xs text-sh-gray mb-1">
            Order #
          </label>
          <input
            id="filter-orderno"
            type="text"
            value={filterOrderno}
            onChange={(e) => setFilterOrderno(e.target.value)}
            placeholder="SO-12345..."
            className="border border-gray-300 rounded px-3 min-h-[44px] w-full text-sm"
          />
        </div>
        <div>
          <label htmlFor="filter-salesperson" className="block text-xs text-sh-gray mb-1">
            Salesperson
          </label>
          <input
            id="filter-salesperson"
            type="text"
            value={filterSalesperson}
            onChange={(e) => setFilterSalesperson(e.target.value)}
            placeholder="Name..."
            className="border border-gray-300 rounded px-3 min-h-[44px] w-full text-sm"
          />
        </div>
        <div>
          <label htmlFor="filter-store" className="block text-xs text-sh-gray mb-1">
            Store
          </label>
          <input
            id="filter-store"
            type="text"
            value={filterStore}
            onChange={(e) => setFilterStore(e.target.value)}
            placeholder="Store name..."
            className="border border-gray-300 rounded px-3 min-h-[44px] w-full text-sm"
          />
        </div>
        <div>
          <label htmlFor="filter-from" className="block text-xs text-sh-gray mb-1">
            From
          </label>
          <input
            id="filter-from"
            type="date"
            value={filterDateFrom}
            onChange={(e) => setFilterDateFrom(e.target.value)}
            className="border border-gray-300 rounded px-3 min-h-[44px] w-full text-sm"
          />
        </div>
        <div>
          <label htmlFor="filter-to" className="block text-xs text-sh-gray mb-1">
            To
          </label>
          <input
            id="filter-to"
            type="date"
            value={filterDateTo}
            onChange={(e) => setFilterDateTo(e.target.value)}
            className="border border-gray-300 rounded px-3 min-h-[44px] w-full text-sm"
          />
        </div>
      </div>
      <Button onClick={onSearch} disabled={loading} className="min-h-[44px]">
        {loading ? "Searching..." : "Search"}
      </Button>
    </div>
  );
}

interface BulkAssignControlsProps {
  staff: StaffOption[];
  selectedCount: number;
  bulkPrimary: number | "";
  bulkSplit: number | "" | "clear";
  saving: boolean;
  setBulkPrimary: (v: number | "") => void;
  setBulkSplit: (v: number | "" | "clear") => void;
  onApply: () => void;
}

function BulkAssignControls({
  staff,
  selectedCount,
  bulkPrimary,
  bulkSplit,
  saving,
  setBulkPrimary,
  setBulkSplit,
  onApply,
}: Readonly<BulkAssignControlsProps>) {
  return (
    <div className="rounded-lg border border-gray-200 bg-sh-linen p-4">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <label htmlFor="bulk-primary" className="block text-xs text-sh-gray mb-1">
            Assign Primary ({selectedCount} selected)
          </label>
          <select
            id="bulk-primary"
            value={bulkPrimary}
            onChange={(e) => setBulkPrimary(e.target.value ? Number(e.target.value) : "")}
            className="border border-gray-300 rounded px-3 min-h-[44px] text-sm"
          >
            <option value="">Select...</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.displayName}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="bulk-split" className="block text-xs text-sh-gray mb-1">
            Split With (optional)
          </label>
          <select
            id="bulk-split"
            value={bulkSplit}
            onChange={(e) => {
              const val = e.target.value;
              if (val === "clear") {
                setBulkSplit("clear");
              } else {
                setBulkSplit(val ? Number(val) : "");
              }
            }}
            className="border border-gray-300 rounded px-3 min-h-[44px] text-sm"
          >
            <option value="">No change</option>
            <option value="clear">Clear split</option>
            {staff
              .filter((s) => s.id !== bulkPrimary)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.displayName}
                </option>
              ))}
          </select>
        </div>
        <Button
          onClick={onApply}
          disabled={saving || selectedCount === 0}
          className="min-h-[44px] inline-flex items-center gap-2"
        >
          <UserCog className="h-4 w-4" />
          {saving ? "Updating..." : "Apply to Selected"}
        </Button>
      </div>
    </div>
  );
}

interface OrdersTableProps {
  orders: OrderRow[];
  staff: StaffOption[];
  onToggleSelect: (id: number) => void;
  onToggleAll: () => void;
}

function OrdersTable({ orders, staff, onToggleSelect, onToggleAll }: Readonly<OrdersTableProps>) {
  const allSelected = orders.length > 0 && orders.every((o) => o.selected);
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200">
      <table className="w-full text-sm">
        <thead className="bg-sh-linen">
          <tr>
            <th className="px-3 py-3 text-left">
              <input
                type="checkbox"
                aria-label="Select all orders"
                checked={allSelected}
                onChange={onToggleAll}
                className="h-5 w-5"
              />
            </th>
            <th className="px-3 py-3 text-left text-xs font-medium text-sh-gray">Order #</th>
            <th className="px-3 py-3 text-left text-xs font-medium text-sh-gray">Date</th>
            <th className="px-3 py-3 text-left text-xs font-medium text-sh-gray">Customer</th>
            <th className="px-3 py-3 text-left text-xs font-medium text-sh-gray">Salesperson</th>
            <th className="px-3 py-3 text-left text-xs font-medium text-sh-gray">Split</th>
            <th className="px-3 py-3 text-left text-xs font-medium text-sh-gray">Store</th>
            <th className="px-3 py-3 text-left text-xs font-medium text-sh-gray">Status</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((order, i) => (
            <OrderTableRow
              key={order.id}
              order={order}
              index={i}
              staff={staff}
              onToggleSelect={onToggleSelect}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface OrderTableRowProps {
  order: OrderRow;
  index: number;
  staff: StaffOption[];
  onToggleSelect: (id: number) => void;
}

function rowClassName(order: OrderRow, index: number): string {
  if (order.selected) return "bg-blue-50";
  return index % 2 === 1 ? "bg-sh-stripe" : "bg-white";
}

function OrderTableRow({ order, index, staff, onToggleSelect }: Readonly<OrderTableRowProps>) {
  const custName = order.customer
    ? [order.customer.firstName, order.customer.lastName].filter(Boolean).join(" ") || "—"
    : "—";
  const splitName = order.splitWithId
    ? staff.find((s) => s.id === order.splitWithId)?.displayName || "—"
    : "";
  return (
    <tr className={`border-b border-gray-100 ${rowClassName(order, index)}`}>
      <td className="px-3 py-3">
        <input
          type="checkbox"
          aria-label={`Select order ${order.orderno}`}
          checked={order.selected}
          onChange={() => onToggleSelect(order.id)}
          className="h-5 w-5"
        />
      </td>
      <td className="px-3 py-3 font-mono text-sh-navy">{order.orderno}</td>
      <td className="px-3 py-3 text-sh-gray">{formatDate(order.orderDate)}</td>
      <td className="px-3 py-3 text-sh-navy">{custName}</td>
      <td className="px-3 py-3 text-sh-navy">{order.salesperson || "—"}</td>
      <td className="px-3 py-3 text-sh-gray">
        {splitName && (
          <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
            50/50 {splitName}
          </span>
        )}
      </td>
      <td className="px-3 py-3 text-sh-gray">{order.storeLocation || "—"}</td>
      <td className="px-3 py-3">
        <span className="text-xs">{order.status}</span>
      </td>
    </tr>
  );
}
