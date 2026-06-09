"use client";

// /app/src/app/(dashboard)/app/sales/orders/OrdersListView.tsx
//
// Sales orders list body. App Router port of the legacy sales/orders/index body.
// Replicates StandardListPage's search + pagination inline (without its
// MainLayout chrome, which the (dashboard) layout supplies), reading the shared
// /api/sales/orders REST endpoint. The status filter seeds from ?status= (e.g.
// /sales/orders?status=QUOTE); the My/All quote scope filters QUOTEs to the
// signed-in user.

import { useState, useEffect, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { format } from "date-fns";
import axios from "axios";
import { toast } from "react-toastify";
import TableWithFilters from "@/components/table/TableWithFilters";
import { type Column } from "@/components/table/PaginatedTable";
import { parseLocalDate } from "@/lib/dateUtils";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";

interface OrderRow {
  id: number;
  orderno: string;
  orderDate: string;
  status: string;
  salesperson: string | null;
  storeLocation: string | null;
  customerName: string | null;
  totalPaid: number;
  totalAmount: number;
}

const STATUS_LABELS: Record<string, string> = {
  QUOTE: "Quote",
  ORDER: "Order",
  FULFILLED: "Fulfilled",
  CANCELLED: "Cancelled",
};

const STATUS_COLORS: Record<string, string> = {
  QUOTE: "bg-amber-100 text-amber-800",
  ORDER: "bg-blue-100 text-blue-800",
  FULFILLED: "bg-green-100 text-green-800",
  CANCELLED: "bg-red-100 text-red-800",
};

export function OrdersListView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  const formatCurrency = useMoneyFormatter();

  const [statusFilter, setStatusFilter] = useState(searchParams?.get("status") ?? "");
  // "mine" scopes quotes to the current user; only relevant when status=QUOTE
  const [quoteScope, setQuoteScope] = useState<"mine" | "all">("mine");
  const [data, setData] = useState<OrderRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string | number> = { page, search, limit: 10 };
      if (statusFilter) params.status = statusFilter;
      if (statusFilter === "QUOTE" && quoteScope === "mine" && session?.user?.name) {
        params.salesperson = session.user.name;
      }
      const res = await axios.get("/api/sales/orders", { params });
      setData(res.data.orders || []);
      setTotal(res.data.total || 0);
    } catch {
      toast.error("Failed to load sales orders");
    } finally {
      setLoading(false);
    }
  }, [page, search, statusFilter, quoteScope, session?.user?.name]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSearchChange = (newSearchTerm: string) => {
    setPage(1);
    setSearch(newSearchTerm);
  };

  const columns: Column[] = [
    { key: "orderno", label: "Order #", accessor: "orderno", width: "120px" },
    {
      key: "status",
      label: "Status",
      accessor: "status",
      width: "100px",
      render: (row: OrderRow) => (
        <span
          className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[row.status] || "bg-gray-100 text-gray-800"}`}
        >
          {STATUS_LABELS[row.status] || row.status}
        </span>
      ),
    },
    {
      key: "orderDate",
      label: "Date",
      accessor: "orderDate",
      width: "120px",
      render: (row: OrderRow) =>
        row.orderDate ? format(parseLocalDate(row.orderDate), "MM/dd/yyyy") : "-",
    },
    { key: "customerName", label: "Customer", accessor: "customerName", width: "200px" },
    {
      key: "salesperson",
      label: "Salesperson",
      accessor: "salesperson",
      width: "150px",
      render: (row: OrderRow) => row.salesperson || "-",
    },
    {
      key: "storeLocation",
      label: "Store",
      accessor: "storeLocation",
      width: "140px",
      render: (row: OrderRow) => row.storeLocation || "-",
    },
    {
      key: "totalAmount",
      label: "Total",
      accessor: "totalAmount",
      width: "110px",
      align: "right" as const,
      render: (row: OrderRow) => {
        const val = Number(row.totalAmount) || 0;
        return val === 0 ? "--" : formatCurrency(val);
      },
    },
    {
      key: "totalPaid",
      label: "Paid",
      accessor: "totalPaid",
      width: "110px",
      align: "right" as const,
      render: (row: OrderRow) => {
        const val = Number(row.totalPaid) || 0;
        return val === 0 ? "--" : formatCurrency(val);
      },
    },
  ];

  return (
    <div className="py-2 font-serif text-sh-black">
      <h1 className="mb-4 text-2xl font-semibold text-sh-blue">Sales Orders</h1>

      <div className="flex gap-2 mb-2">
        {["", "QUOTE", "ORDER", "FULFILLED", "CANCELLED"].map((s) => (
          <button
            key={s}
            onClick={() => {
              setStatusFilter(s);
              setPage(1);
            }}
            className={`px-3 py-1.5 text-sm rounded-full border transition ${
              statusFilter === s
                ? "bg-sh-blue text-white border-sh-blue"
                : "bg-white text-sh-gray border-sh-gray/30 hover:border-sh-blue"
            }`}
          >
            {s ? STATUS_LABELS[s] : "All"}
          </button>
        ))}
      </div>
      {statusFilter === "QUOTE" && (
        <div className="flex gap-2 mb-3">
          {(["mine", "all"] as const).map((scope) => (
            <button
              key={scope}
              onClick={() => {
                setQuoteScope(scope);
                setPage(1);
              }}
              className={`px-3 py-1 text-xs rounded-full border transition ${
                quoteScope === scope
                  ? "bg-sh-gold text-white border-sh-gold"
                  : "bg-white text-sh-gray border-sh-gray/30 hover:border-sh-gold"
              }`}
            >
              {scope === "mine" ? "My Quotes" : "All Quotes"}
            </button>
          ))}
        </div>
      )}

      <TableWithFilters<OrderRow>
        data={data}
        columns={columns}
        searchFields={[]}
        storageKey="sales-orders-filters"
        total={total}
        page={page}
        onPageChange={setPage}
        loading={loading}
        onRowClick={(row) => router.push(`/app/sales/orders/${row.id}`)}
        onSearchChange={handleSearchChange}
      />
    </div>
  );
}
