"use client";

// /app/src/app/(dashboard)/app/sales/customers/CustomersListView.tsx
//
// Customers list body. App Router port of the legacy sales/customers/index body.
// Replicates StandardListPage's search + pagination inline (without its
// MainLayout chrome, which the (dashboard) layout supplies), reading the shared
// /api/customers REST endpoint. New-customer modal + Recalculate Levels
// (manager-gated) preserved.

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import axios from "axios";
import { Customer, CustomerAddress } from "@prisma/client";
import { toast } from "react-toastify";
import TableWithFilters from "@/components/table/TableWithFilters";
import { type Column } from "@/components/table/PaginatedTable";
import CustomerEditModal from "@/components/modals/CustomerEditModal";
import { Button } from "@/components/ui/button";
import { useEffectiveRole } from "@/lib/hooks/useEffectiveRole";

type CustomerWithIncludes = Customer & {
  addresses: CustomerAddress[];
  externalIds: { externalId: string }[];
};

export function CustomersListView() {
  const router = useRouter();
  const { effectiveRole } = useEffectiveRole();
  const isManager =
    effectiveRole === "MANAGER" || effectiveRole === "ADMIN" || effectiveRole === "SUPER_ADMIN";

  const [data, setData] = useState<CustomerWithIncludes[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<CustomerWithIncludes | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [recalculating, setRecalculating] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const { data: res } = await axios.get("/api/customers", {
        params: { page, search, limit: 10, sortBy: "lastName", sortDirection: "asc" },
      });
      setData(res.data);
      setTotal(res.totalPages * 10);
    } catch {
      toast.error("Failed to load customers");
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => {
    loadData();
  }, [loadData, refreshTrigger]);

  const handleSearchChange = (newSearchTerm: string) => {
    setPage(1);
    setSearch(newSearchTerm);
  };

  const handleRecalculateLevels = async () => {
    setRecalculating(true);
    try {
      const { data: res } = await axios.post("/api/customers/recalculate-levels");
      const groups = Object.keys(res.groupStats || {}).length;
      toast.success(`Updated ${res.customersUpdated} customers across ${groups} department groups`);
      setRefreshTrigger(Date.now());
    } catch {
      toast.error("Failed to recalculate customer levels.");
    } finally {
      setRecalculating(false);
    }
  };

  const handleCloseModal = () => {
    setEditingCustomer(null);
    setRefreshTrigger(Date.now());
  };

  const columns: Column[] = [
    {
      key: "name",
      label: "Name",
      accessor: "lastName",
      render: (customer: CustomerWithIncludes) =>
        `${customer.firstName || ""} ${customer.lastName || ""}`.trim(),
    },
    {
      key: "email",
      label: "Email",
      accessor: "email",
    },
    {
      key: "phone",
      label: "Phone",
      accessor: "phone",
    },
    {
      key: "address",
      label: "Primary Address",
      accessor: "addresses",
      render: (customer: CustomerWithIncludes) => {
        const address = customer.addresses[0];
        return address
          ? `${address.address1}, ${address.city}, ${address.state} ${address.zip}`
          : "N/A";
      },
    },
    {
      key: "customerLevel",
      label: "Level",
      accessor: "customerLevel",
      render: (customer: CustomerWithIncludes) => {
        const level = customer.customerLevel as number | null;
        const peak = customer.peakCustomerLevel as number | null;
        if (!level && peak) {
          const labels: Record<number, string> = {
            1: "Occasional",
            2: "Frequent",
            3: "High Value",
            4: "VIP",
          };
          return (
            <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700">
              Dormant — was {labels[peak] || ""}
            </span>
          );
        }
        if (!level) return null;
        const config: Record<number, { label: string; className: string }> = {
          1: { label: "Occasional", className: "bg-sh-gray/20 text-sh-gray" },
          2: { label: "Frequent", className: "bg-sh-brand-blue/20 text-sh-brand-blue" },
          3: { label: "High Value", className: "bg-sh-gold/20 text-sh-gold" },
          4: { label: "VIP", className: "bg-green-100 text-green-800" },
        };
        const c = config[level];
        if (!c) return null;
        return (
          <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${c.className}`}>
            {c.label}
          </span>
        );
      },
    },
    {
      key: "externalIds",
      label: "POS IDs",
      accessor: "externalIds",
      render: (customer: CustomerWithIncludes) =>
        customer.externalIds.map((id) => id.externalId).join(", "),
    },
  ];

  return (
    <div className="py-2 font-serif text-sh-black">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-semibold text-sh-blue">Customers</h1>
        <div className="flex gap-2">
          {isManager && (
            <Button variant="secondary" onClick={handleRecalculateLevels} disabled={recalculating}>
              {recalculating ? "Recalculating..." : "Recalculate Levels"}
            </Button>
          )}
          <Button onClick={() => setEditingCustomer({} as CustomerWithIncludes)}>
            New Customer
          </Button>
        </div>
      </div>

      <TableWithFilters<CustomerWithIncludes>
        data={data}
        columns={columns}
        searchFields={[]}
        storageKey="customer-filters"
        total={total}
        page={page}
        onPageChange={setPage}
        loading={loading}
        onRowClick={(customer) => router.push(`/app/sales/customers/${customer.id}`)}
        onSearchChange={handleSearchChange}
      />

      {editingCustomer && <CustomerEditModal item={editingCustomer} onClose={handleCloseModal} />}
    </div>
  );
}
