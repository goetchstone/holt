"use client";

// /app/src/app/(dashboard)/app/purchasing/orders/[id]/receive/ReceivePOView.tsx
//
// Receive Shipment -- scanner-optimized receiving flow. App Router port; reads
// the shared /api/purchasing/orders/[id] (GET + receive POST) +
// /api/warehouse/locations + /api/print-label/batch REST endpoints, which stay
// REST. The legacy page used ScannerLayout chrome; here the (dashboard) layout
// supplies chrome, so only the scanner-optimized body is kept. The id arrives as
// a prop from the server page (params awaited there).

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { toast } from "react-toastify";

interface LineItem {
  id: number;
  partNo?: string;
  productName?: string;
  productNumber?: string;
  productId?: number;
  productVariantId?: number;
  variantUpc?: string;
  orderedQuantity: number;
  unitCost: number;
  totalReceived: number;
  salesOrderNo: string | null;
  selectedGrade?: string;
}

interface POData {
  id: number;
  poNumber: string;
  vendor: { id: number; name: string };
  status: string;
  lineItems: LineItem[];
}

interface StockLoc {
  id: number;
  code: string;
  name: string;
  locationType: string;
  isActive: boolean;
}

interface StoreLoc {
  id: number;
  name: string;
  code: string;
  stockLocations: StockLoc[];
  defaultReceivingStockLocationId: number | null;
}

interface ReceiveLineState {
  itemId: number;
  selected: boolean;
  quantity: number;
  stockLocationId: number | null;
  condition: string;
  printTag: boolean;
  upc: string;
  needsUpc: boolean;
}

const CONDITIONS = ["OK", "Damaged", "Wrong Item", "Short"];

export function ReceivePOView({ id }: { id: string }) {
  const router = useRouter();

  const [po, setPo] = useState<POData | null>(null);
  const [stores, setStores] = useState<StoreLoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const [selectedStoreId, setSelectedStoreId] = useState<number | null>(null);
  const [lineStates, setLineStates] = useState<ReceiveLineState[]>([]);

  useEffect(() => {
    if (!id) return;
    Promise.all([
      axios.get(`/api/purchasing/orders/${encodeURIComponent(String(id))}`),
      axios.get("/api/warehouse/locations"),
    ])
      .then(([poRes, locRes]) => {
        const poData = poRes.data as POData;
        setPo(poData);

        const locs = locRes.data.locations as StoreLoc[];
        setStores(locs);
        if (locs.length > 0) setSelectedStoreId(locs[0].id);

        const defaultStore = locs[0];
        const defaultStockId = defaultStore?.defaultReceivingStockLocationId || null;

        setLineStates(
          poData.lineItems
            .filter((li) => li.totalReceived < li.orderedQuantity)
            .map((li) => ({
              itemId: li.id,
              selected: true,
              quantity: li.orderedQuantity - li.totalReceived,
              stockLocationId: defaultStockId,
              condition: "OK",
              printTag: !li.productVariantId,
              upc: "",
              needsUpc: !!li.productVariantId && !li.variantUpc,
            })),
        );
      })
      .catch(() => toast.error("Failed to load data"))
      .finally(() => setLoading(false));
  }, [id]);

  const selectedStore = stores.find((s) => s.id === selectedStoreId);
  const stockLocations = selectedStore?.stockLocations?.filter((sl) => sl.isActive) || [];

  const updateLine = (itemId: number, updates: Partial<ReceiveLineState>) => {
    setLineStates((prev) => prev.map((ls) => (ls.itemId === itemId ? { ...ls, ...updates } : ls)));
  };

  const handleStoreChange = (storeId: number) => {
    setSelectedStoreId(storeId);
    const store = stores.find((s) => s.id === storeId);
    const defaultStockId = store?.defaultReceivingStockLocationId || null;
    setLineStates((prev) => prev.map((ls) => ({ ...ls, stockLocationId: defaultStockId })));
  };

  const handleReceive = async () => {
    if (!selectedStoreId || !po) return;

    const selected = lineStates.filter((ls) => ls.selected && ls.quantity > 0);
    if (selected.length === 0) {
      toast.error("No items selected for receiving");
      return;
    }

    setSubmitting(true);
    try {
      const res = await axios.post(`/api/purchasing/orders/${po.id}/receive`, {
        storeLocationId: selectedStoreId,
        items: selected.map((ls) => ({
          purchaseOrderItemId: ls.itemId,
          quantityReceived: ls.quantity,
          destinationStockLocationId: ls.stockLocationId,
          condition: ls.condition,
          printTag: ls.printTag,
          variantUpc: ls.upc || undefined,
        })),
      });

      const { printItems } = res.data;
      toast.success(res.data.message);

      // Auto-route print: each product routes to the correct template and printer
      // based on its category's label template and the printer's loaded tag size.
      if (printItems?.length > 0) {
        try {
          const printPayload = printItems.map((pi: { productId: number; quantity: number }) => ({
            productId: pi.productId,
            copies: pi.quantity,
          }));
          const printRes = await axios.post("/api/print-label/batch", { items: printPayload });
          const failed = printRes.data.results?.filter((r: { success: boolean }) => !r.success);
          if (failed?.length > 0) {
            const errors = failed.map((f: { productId: number; error: string }) => f.error);
            toast.error(`Some tags failed: ${errors.join("; ")}`);
          } else {
            toast.success("Tags sent to printer");
          }
        } catch {
          toast.error("Items received but tag printing failed");
        }
      }

      const poRes = await axios.get(`/api/purchasing/orders/${po.id}`);
      const updated = poRes.data as POData;
      setPo(updated);

      const defaultStockId = selectedStore?.defaultReceivingStockLocationId || null;
      setLineStates(
        updated.lineItems
          .filter((li) => li.totalReceived < li.orderedQuantity)
          .map((li) => ({
            itemId: li.id,
            selected: true,
            quantity: li.orderedQuantity - li.totalReceived,
            stockLocationId: defaultStockId,
            condition: "OK",
            printTag: !li.productVariantId,
            upc: "",
            needsUpc: !!li.productVariantId && !li.variantUpc,
          })),
      );
    } catch (error: unknown) {
      const msg = axios.isAxiosError(error)
        ? error.response?.data?.error
        : "Failed to receive items";
      toast.error(msg || "Failed to receive items");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <p className="text-sh-gray p-4">Loading...</p>;
  }

  if (!po) {
    return <p className="text-sh-gray p-4">Purchase order not found.</p>;
  }

  const allReceived = po.lineItems.every((li) => li.totalReceived >= li.orderedQuantity);

  return (
    <div className="max-w-2xl mx-auto space-y-3">
      {/* PO Header */}
      <div className="bg-white rounded-lg border border-sh-gray/20 shadow-sm p-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-serif font-semibold text-sh-blue">PO {po.poNumber}</h2>
            <p className="text-sm text-sh-gray">{po.vendor.name}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => router.push(`/app/purchasing/orders/${po.id}`)}
          >
            Back
          </Button>
        </div>
      </div>

      {/* Config bar: receiving location */}
      <div className="bg-white rounded-lg border border-sh-gray/20 shadow-sm p-3">
        <div>
          <label className="block text-xs text-sh-gray mb-1">Receiving At</label>
          <select
            value={selectedStoreId || ""}
            onChange={(e) => handleStoreChange(Number.parseInt(e.target.value))}
            className="w-full border border-sh-gray/30 rounded px-2 py-2 text-sm"
          >
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {allReceived ? (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-center">
          <p className="text-green-800 font-serif font-semibold">All items received</p>
        </div>
      ) : (
        <>
          {/* Line items */}
          <div className="space-y-2">
            {po.lineItems.map((li) => {
              const remaining = li.orderedQuantity - li.totalReceived;
              if (remaining <= 0) return null;

              const ls = lineStates.find((s) => s.itemId === li.id);
              if (!ls) return null;

              return (
                <div
                  key={li.id}
                  className={`bg-white rounded-lg border shadow-sm p-3 ${
                    ls.selected ? "border-sh-blue/30" : "border-sh-gray/20 opacity-60"
                  }`}
                >
                  {/* Item header with checkbox */}
                  <div className="flex items-start gap-3 mb-2">
                    <input
                      type="checkbox"
                      checked={ls.selected}
                      onChange={(e) => updateLine(li.id, { selected: e.target.checked })}
                      className="mt-1 rounded w-5 h-5"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-sh-black truncate">
                        {li.productName || li.partNo || "Unknown"}
                      </p>
                      <p className="text-xs text-sh-gray">
                        {li.partNo && `${li.partNo} · `}
                        Ordered: {li.orderedQuantity} · Received: {li.totalReceived} · Remaining:{" "}
                        {remaining}
                        {li.salesOrderNo && (
                          <span className="text-sh-blue ml-1">SO: {li.salesOrderNo}</span>
                        )}
                      </p>
                    </div>
                  </div>

                  {ls.selected && (
                    <div className="grid grid-cols-2 gap-2 mt-2">
                      <div>
                        <label className="block text-[10px] text-sh-gray mb-0.5">Qty</label>
                        <input
                          type="number"
                          min={1}
                          max={remaining}
                          value={ls.quantity}
                          onChange={(e) =>
                            updateLine(li.id, { quantity: Number.parseInt(e.target.value) || 0 })
                          }
                          className="w-full border border-sh-gray/30 rounded px-2 py-1.5 text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] text-sh-gray mb-0.5">Destination</label>
                        <select
                          value={ls.stockLocationId || ""}
                          onChange={(e) =>
                            updateLine(li.id, {
                              stockLocationId: e.target.value
                                ? Number.parseInt(e.target.value)
                                : null,
                            })
                          }
                          className="w-full border border-sh-gray/30 rounded px-2 py-1.5 text-sm"
                        >
                          <option value="">Default</option>
                          {stockLocations.map((sl) => (
                            <option key={sl.id} value={sl.id}>
                              {sl.code} - {sl.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-[10px] text-sh-gray mb-0.5">Condition</label>
                        <select
                          value={ls.condition}
                          onChange={(e) => updateLine(li.id, { condition: e.target.value })}
                          className="w-full border border-sh-gray/30 rounded px-2 py-1.5 text-sm"
                        >
                          {CONDITIONS.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="flex items-end pb-1">
                        <label className="flex items-center gap-2 text-sm text-sh-gray cursor-pointer">
                          <input
                            type="checkbox"
                            checked={ls.printTag}
                            onChange={(e) => updateLine(li.id, { printTag: e.target.checked })}
                            className="rounded w-5 h-5"
                          />
                          Print Tag
                        </label>
                      </div>
                      {ls.needsUpc && (
                        <div className="col-span-2">
                          <label className="block text-[10px] text-sh-gray mb-0.5">
                            Manufacturer UPC (scan barcode)
                          </label>
                          <input
                            type="text"
                            value={ls.upc}
                            onChange={(e) => updateLine(li.id, { upc: e.target.value })}
                            placeholder="Scan or enter UPC..."
                            className="w-full border border-sh-gray/30 rounded px-2 py-1.5 text-sm"
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Receive button */}
          <div className="sticky bottom-0 bg-sh-linen py-3">
            <Button
              className="w-full py-3 text-base"
              onClick={handleReceive}
              disabled={submitting || lineStates.filter((ls) => ls.selected).length === 0}
            >
              {submitting
                ? "Receiving..."
                : `Receive ${lineStates.filter((ls) => ls.selected).length} Item(s)`}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
