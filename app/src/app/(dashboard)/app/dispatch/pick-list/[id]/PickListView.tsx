"use client";

// /app/src/app/(dashboard)/app/dispatch/pick-list/[id]/PickListView.tsx
//
// Pick list detail: warehouse pick view with items grouped by location, a pick
// progress bar, per-item picked toggles, and a print button. App Router port of
// the legacy pages/dispatch/pick-list/[id].tsx body (minus MainLayout chrome,
// which comes from the (dashboard) layout). The dynamic id arrives as a prop from
// the server page. Reads the shared /api/dispatch/pick-lists/* REST endpoints.

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import axios from "axios";
import { toast } from "react-toastify";
import Link from "next/link";
import { Printer } from "lucide-react";

// Global print styles: hide chrome and print the list cleanly. Kept as a plain
// <style> tag (App Router client component) -- same global effect as the legacy
// styled-jsx global block.
const PRINT_STYLES = `
@media print {
  nav,
  header,
  .no-print {
    display: none !important;
  }
  body {
    background: white !important;
  }
  .print-only {
    display: block !important;
  }
}
`;

type PickListItemData = {
  id: number;
  productId: number;
  quantity: number;
  picked: boolean;
  pickedAt: string | null;
  notes: string | null;
  product: {
    id: number;
    name: string;
    productNumber: string | null;
  };
  orderLineItem: {
    id: number;
    productName: string | null;
  } | null;
  fromStockLocation: {
    id: number;
    name: string;
  } | null;
  fromStoreLocation: {
    id: number;
    name: string;
  } | null;
};

type PickListData = {
  id: number;
  pickListNumber: string;
  status: string;
  assignedToId: number | null;
  assignedTo: { id: number; displayName: string } | null;
  deliveryRunId: number | null;
  salesOrderId: number | null;
  notes: string | null;
  items: PickListItemData[];
};

export function PickListView({ id }: { id: string }) {
  const [pickList, setPickList] = useState<PickListData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchPickList = useCallback(async () => {
    if (!id) return;
    try {
      const res = await axios.get(`/api/dispatch/pick-lists/${encodeURIComponent(String(id))}`);
      setPickList(res.data);
    } catch {
      toast.error("Failed to load pick list");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchPickList();
  }, [fetchPickList]);

  async function toggleItemPicked(itemId: number, picked: boolean) {
    if (!pickList) return;
    try {
      await axios.put(`/api/dispatch/pick-lists/${pickList.id}/items`, {
        itemId,
        picked,
      });
      fetchPickList();
    } catch {
      toast.error("Failed to update item");
    }
  }

  if (loading) {
    return <div className="text-center py-12 text-sh-gray">Loading...</div>;
  }

  if (!pickList) {
    return (
      <div className="text-center py-12">
        <p className="text-sh-gray mb-4">Pick list not found</p>
        <Link href="/app/dispatch">
          <Button variant="outline">Back to Dispatch</Button>
        </Link>
      </div>
    );
  }

  const pickedCount = pickList.items.filter((item) => item.picked).length;
  const totalItems = pickList.items.length;
  const progressPercent = totalItems > 0 ? (pickedCount / totalItems) * 100 : 0;

  // Group items by location
  const grouped = groupByLocation(pickList.items);

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: PRINT_STYLES }} />

      <div className="mb-4 no-print">
        <Link
          href="/app/dispatch"
          className="text-sm text-sh-blue hover:underline min-h-[44px] inline-flex items-center"
        >
          Back to Dispatch
        </Link>
      </div>

      {/* Header */}
      <div className="bg-white border border-sh-gray/10 rounded-lg p-4 mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div>
            <h1 className="font-serif text-xl text-sh-navy">{pickList.pickListNumber}</h1>
            {pickList.assignedTo && (
              <p className="text-sm text-sh-gray">Assigned to {pickList.assignedTo.displayName}</p>
            )}
          </div>
          <div className="flex items-center gap-3">
            <StatusBadge status={pickList.status} />
            <button
              onClick={() => globalThis.print()}
              className="no-print p-3 rounded-lg border border-sh-gray/20 hover:bg-sh-linen transition min-w-[44px] min-h-[44px] flex items-center justify-center"
              aria-label="Print pick list"
            >
              <Printer className="w-5 h-5 text-sh-navy" />
            </button>
          </div>
        </div>

        {/* Progress bar */}
        <div className="flex items-center gap-3">
          <div className="flex-1 h-3 bg-sh-stripe rounded-full overflow-hidden">
            <div
              className="h-full bg-sh-gold rounded-full transition-all"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <span className="text-sm font-semibold text-sh-navy whitespace-nowrap">
            {pickedCount} of {totalItems} picked
          </span>
        </div>
      </div>

      {/* Item list grouped by location */}
      <div className="space-y-6">
        {grouped.map((group) => (
          <div key={group.locationName}>
            <h2 className="font-serif text-base text-sh-navy mb-2 uppercase tracking-wide">
              {group.locationName}
            </h2>

            <div className="bg-white border border-sh-gray/10 rounded-lg divide-y divide-sh-gray/10">
              {group.items.map((item) => (
                <div
                  key={item.id}
                  className={`flex items-start gap-3 p-4 ${item.picked ? "bg-sh-stripe/50" : ""}`}
                >
                  <label className="flex items-center justify-center min-w-[44px] min-h-[44px] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={item.picked}
                      onChange={() => toggleItemPicked(item.id, !item.picked)}
                      className="w-6 h-6 rounded border-sh-gray/30 text-sh-blue focus:ring-sh-blue cursor-pointer"
                    />
                  </label>

                  <div className="flex-1">
                    <div className={item.picked ? "line-through text-sh-gray" : "text-sh-navy"}>
                      <span className="font-semibold text-sm">{item.product.name}</span>
                      {item.product.productNumber && (
                        <span className="text-sh-gray text-xs ml-2">
                          {item.product.productNumber}
                        </span>
                      )}
                    </div>

                    <div className="text-xs text-sh-gray mt-0.5">Qty: {item.quantity}</div>

                    {item.notes && <div className="text-xs text-sh-gray mt-0.5">{item.notes}</div>}

                    {item.picked && item.pickedAt && (
                      <div className="text-xs text-green-600 mt-0.5">
                        Picked at {new Date(item.pickedAt).toLocaleTimeString()}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {totalItems === 0 && (
        <div className="bg-white border border-sh-gray/10 rounded-lg p-6 text-center text-sh-gray text-sm">
          No items on this pick list
        </div>
      )}
    </>
  );
}

function groupByLocation(items: PickListItemData[]) {
  const groups: Record<string, PickListItemData[]> = {};

  for (const item of items) {
    const locationName =
      item.fromStockLocation?.name || item.fromStoreLocation?.name || "Unknown Location";

    if (!groups[locationName]) {
      groups[locationName] = [];
    }
    groups[locationName].push(item);
  }

  return Object.entries(groups).map(([locationName, items]) => ({
    locationName,
    items,
  }));
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    CREATED: "bg-sh-linen text-sh-gray",
    IN_PROGRESS: "bg-sh-blue/10 text-sh-blue",
    COMPLETED: "bg-green-50 text-green-700",
  };

  return (
    <span
      className={`text-xs px-2 py-1 rounded-full ${colors[status] || "bg-sh-linen text-sh-gray"}`}
    >
      {status.replace("_", " ")}
    </span>
  );
}
