"use client";

// /app/src/app/(dashboard)/app/inventory/reconciled-items/ReconciledItemsView.tsx
//
// Reconciled Items body (table of resolved variance items with an undo action).
// App Router port of the legacy pages/inventory/reconciled-items.tsx body, minus
// MainLayout chrome (supplied by the (dashboard) layout). Reads the ?location= /
// ?reportType= params via useSearchParams and the shared /api/inventory/* REST
// endpoints.

import { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import axios from "axios";
import { toast } from "react-toastify";
import Link from "next/link";
import { ArrowLeft, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";

interface ReconciledItem {
  id: number;
  product: { name: string; productNumber: string };
  barcode: string;
  initialVariance: number;
  actionTaken: string;
  finalVariance: number;
  reconciledBy: { name: string | null };
}

function backHrefFor(reportType: string | null, location: string | null): string {
  return reportType === "apparel"
    ? `/app/inventory/variance-apparel?location=${location}`
    : `/app/inventory/variance-report?location=${location}`;
}

interface TableBodyProps {
  loading: boolean;
  items: ReconciledItem[];
  onUndo: (id: number) => void;
}

function ReconciledTableBody({ loading, items, onUndo }: Readonly<TableBodyProps>) {
  if (loading) {
    return (
      <tr>
        <td colSpan={7} className="p-4 text-center text-sh-gray">
          Loading...
        </td>
      </tr>
    );
  }
  if (items.length === 0) {
    return (
      <tr>
        <td colSpan={7} className="p-4 text-center text-sh-gray">
          No items have been reconciled for this location yet.
        </td>
      </tr>
    );
  }
  return (
    <>
      {items.map((item) => (
        <tr key={item.id} className="odd:bg-white even:bg-sh-stripe">
          <td className="p-2">
            <div className="truncate" title={item.product.name}>
              {item.product.name} ({item.product.productNumber})
            </div>
          </td>
          <td className="p-2 font-mono">{item.barcode}</td>
          <td className="p-2 font-semibold">{item.actionTaken}</td>
          <td className="p-2 text-center">{item.initialVariance}</td>
          <td className="p-2 text-center">{item.finalVariance}</td>
          <td className="p-2">{item.reconciledBy.name}</td>
          <td className="p-2 text-right">
            <Button variant="secondary" size="sm" onClick={() => onUndo(item.id)}>
              <RotateCcw className="w-4 h-4 mr-2" />
              Undo
            </Button>
          </td>
        </tr>
      ))}
    </>
  );
}

export function ReconciledItemsView() {
  const searchParams = useSearchParams();
  const location = searchParams?.get("location") ?? null;
  const reportType = searchParams?.get("reportType") ?? null;

  const [items, setItems] = useState<ReconciledItem[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchItems = useCallback(async () => {
    if (!location) return;
    setLoading(true);
    try {
      const res = await axios.get("/api/inventory/reconciled-items", {
        params: { location, reportType },
      });
      setItems(res.data);
    } catch {
      toast.error("Failed to load reconciled items.");
    } finally {
      setLoading(false);
    }
  }, [location, reportType]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  const handleUndo = async (reconciliationId: number) => {
    const confirmed = globalThis.confirm(
      "Are you sure you want to undo this reconciliation? The item will reappear on the variance report.",
    );
    if (!confirmed) return;
    try {
      await axios.post("/api/inventory/undo-reconciliation", { reconciliationId });
      toast.success("Reconciliation undone.");
      fetchItems();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to undo reconciliation."));
    }
  };

  return (
    <div className="max-w-6xl mx-auto mt-8 font-serif">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-sh-blue">Reconciled Items</h1>
          <p className="text-sh-gray">Showing reconciled items for {location}.</p>
        </div>
        <Link
          href={backHrefFor(reportType, location)}
          className="flex items-center gap-2 text-sh-blue hover:underline"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Variance Report
        </Link>
      </div>

      <div className="border border-sh-gray rounded-lg overflow-hidden shadow-sm">
        <table className="min-w-full text-left text-sm whitespace-nowrap">
          <thead className="bg-sh-linen text-sh-black">
            <tr>
              <th className="p-2">Product</th>
              <th className="p-2">Barcode</th>
              <th className="p-2">Action</th>
              <th className="p-2 text-center">Initial Var.</th>
              <th className="p-2 text-center">Final Var.</th>
              <th className="p-2">Reconciled By</th>
              <th className="p-2"></th>
            </tr>
          </thead>
          <tbody>
            <ReconciledTableBody loading={loading} items={items} onUndo={handleUndo} />
          </tbody>
        </table>
      </div>
    </div>
  );
}
