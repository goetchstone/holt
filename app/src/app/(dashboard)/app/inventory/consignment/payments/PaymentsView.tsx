"use client";

// /app/src/app/(dashboard)/app/inventory/consignment/payments/PaymentsView.tsx
//
// Consignment Payments body: payment-batch list with expandable item detail and
// a create-batch form. App Router port of the legacy inventory/consignment/
// payments body (minus MainLayout chrome). Reads + mutates the shared
// /api/consignment/payments REST endpoints; money uses the tenant formatter.

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import axios from "axios";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { getErrorMessage } from "@/lib/toastError";

interface BatchItem {
  barcode: string;
  quality: string;
  size: string;
  cost: number;
  saleDate: string | null;
  saleCustomerName: string | null;
}

interface PaymentBatch {
  id: string;
  batchDate: string;
  periodStart: string;
  periodEnd: string;
  checkNumber: string;
  poNumber: string | null;
  purchaseOrderId: number | null;
  itemCount: number;
  totalAmount: number;
  status: string;
  items?: BatchItem[];
}

function formatDate(d: string | null): string {
  if (!d) return "-";
  return new Date(d).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function PaymentsView() {
  const fmt = useMoneyFormatter();

  const [batches, setBatches] = useState<PaymentBatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [checkNumber, setCheckNumber] = useState("");
  const [creating, setCreating] = useState(false);
  const [createResult, setCreateResult] = useState<{
    itemCount: number;
    totalAmount: number;
  } | null>(null);

  const fetchBatches = useCallback(async () => {
    setLoading(true);
    try {
      // API returns { batches, total, page, limit } — destructure the array.
      const res = await axios.get<{ batches: PaymentBatch[] }>("/api/consignment/payments");
      setBatches(res.data.batches);
    } catch {
      toast.error("Failed to load payment batches.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBatches();
  }, [fetchBatches]);

  async function toggleExpand(batch: PaymentBatch) {
    if (expandedId === batch.id) {
      setExpandedId(null);
      return;
    }
    if (!batch.items) {
      try {
        const res = await axios.get<PaymentBatch>(`/api/consignment/payments/${batch.id}`);
        setBatches((prev) =>
          prev.map((b) => (b.id === batch.id ? { ...b, items: res.data.items } : b)),
        );
      } catch {
        toast.error("Failed to load batch items.");
        return;
      }
    }
    setExpandedId(batch.id);
  }

  async function handleCreateBatch() {
    if (!periodStart || !periodEnd || !checkNumber) {
      toast.warn("Please fill in all fields.");
      return;
    }
    setCreating(true);
    setCreateResult(null);
    try {
      const res = await axios.post<{ itemCount: number; totalAmount: number }>(
        "/api/consignment/payments",
        { periodStart, periodEnd, checkNumber },
      );
      setCreateResult(res.data);
      toast.success(`Batch created: ${res.data.itemCount} items, ${fmt(res.data.totalAmount)}`);
      fetchBatches();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to create batch."));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="py-2 space-y-6 font-serif">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/app/inventory/consignment" className="text-sh-blue hover:underline text-sm">
            Consignment
          </Link>
          <span className="text-sh-gray">/</span>
          <h1 className="text-2xl font-semibold text-sh-blue">Payments</h1>
        </div>
        <div className="flex gap-3">
          <Link
            href="/app/inventory/consignment/po-management"
            className="px-4 py-2 text-sm font-semibold border border-sh-navy text-sh-navy rounded-lg hover:bg-sh-linen transition min-h-[44px] flex items-center"
          >
            PO Management
          </Link>
          <Link
            href="/app/inventory/consignment/unpaid-sales"
            className="px-4 py-2 text-sm font-semibold border border-sh-navy text-sh-navy rounded-lg hover:bg-sh-linen transition min-h-[44px] flex items-center"
          >
            Unpaid Sales
          </Link>
          <Link
            href="/app/inventory/consignment/credits-owed"
            className="px-4 py-2 text-sm font-semibold border border-sh-navy text-sh-navy rounded-lg hover:bg-sh-linen transition min-h-[44px] flex items-center"
          >
            Credits Owed
          </Link>
          <Button onClick={() => setShowCreate(!showCreate)} className="min-h-[44px]">
            {showCreate ? "Cancel" : "Create Payment Batch"}
          </Button>
        </div>
      </div>

      {showCreate && (
        <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-5 space-y-4">
          <h2 className="text-lg font-semibold text-sh-black">New Payment Batch</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label htmlFor="batch-period-start" className="block text-xs text-sh-gray mb-1">
                Period Start
              </label>
              <input
                id="batch-period-start"
                type="date"
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
                className="border border-sh-gray/40 rounded-lg px-3 min-h-[44px] w-full font-serif text-sh-black"
              />
            </div>
            <div>
              <label htmlFor="batch-period-end" className="block text-xs text-sh-gray mb-1">
                Period End
              </label>
              <input
                id="batch-period-end"
                type="date"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
                className="border border-sh-gray/40 rounded-lg px-3 min-h-[44px] w-full font-serif text-sh-black"
              />
            </div>
            <div>
              <label htmlFor="batch-check-number" className="block text-xs text-sh-gray mb-1">
                Check Number
              </label>
              <input
                id="batch-check-number"
                type="text"
                value={checkNumber}
                onChange={(e) => setCheckNumber(e.target.value)}
                className="border border-sh-gray/40 rounded-lg px-3 min-h-[44px] w-full font-serif text-sh-black"
              />
            </div>
          </div>
          <div className="flex items-center gap-4">
            <Button onClick={handleCreateBatch} disabled={creating} className="min-h-[44px]">
              {creating ? "Generating..." : "Generate Batch"}
            </Button>
            {createResult && (
              <span className="text-sm text-green-700 font-medium">
                {createResult.itemCount} items collected, {fmt(createResult.totalAmount)} total
              </span>
            )}
          </div>
        </div>
      )}

      <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-sh-gray/20 bg-sh-linen">
              <th className="text-left px-4 py-3 text-sh-gray font-semibold">Batch Date</th>
              <th className="text-left px-4 py-3 text-sh-gray font-semibold">Period</th>
              <th className="text-left px-4 py-3 text-sh-gray font-semibold">Check / PO #</th>
              <th className="text-right px-4 py-3 text-sh-gray font-semibold">Items</th>
              <th className="text-right px-4 py-3 text-sh-gray font-semibold">Total</th>
              <th className="text-left px-4 py-3 text-sh-gray font-semibold">Status</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sh-gray">
                  Loading...
                </td>
              </tr>
            )}
            {!loading && batches.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sh-gray">
                  No payment batches found.
                </td>
              </tr>
            )}
            {!loading &&
              batches.map((batch, i) => (
                <BatchRow
                  key={batch.id}
                  batch={batch}
                  striped={i % 2 === 1}
                  expanded={expandedId === batch.id}
                  onToggle={() => toggleExpand(batch)}
                />
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface BatchRowProps {
  batch: PaymentBatch;
  striped: boolean;
  expanded: boolean;
  onToggle: () => void;
}

function BatchRow({ batch, striped, expanded, onToggle }: Readonly<BatchRowProps>) {
  const fmt = useMoneyFormatter();
  return (
    <>
      <tr
        onClick={onToggle}
        className={`border-b border-sh-gray/10 cursor-pointer hover:bg-sh-linen transition ${
          striped ? "bg-sh-stripe" : ""
        }`}
      >
        <td className="px-4 py-3 text-sh-black">{formatDate(batch.batchDate)}</td>
        <td className="px-4 py-3 text-sh-black">
          {formatDate(batch.periodStart)} - {formatDate(batch.periodEnd)}
        </td>
        <td className="px-4 py-3 text-sh-black">
          {batch.checkNumber}
          {batch.poNumber && batch.purchaseOrderId && (
            <Link
              href={`/app/purchasing/orders/${batch.purchaseOrderId}`}
              className="ml-2 text-xs text-sh-blue hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {batch.poNumber}
            </Link>
          )}
          {batch.poNumber && !batch.purchaseOrderId && (
            <span className="ml-2 text-xs text-sh-gray">({batch.poNumber})</span>
          )}
        </td>
        <td className="px-4 py-3 text-sh-black text-right">{batch.itemCount}</td>
        <td className="px-4 py-3 text-sh-black text-right">{fmt(batch.totalAmount)}</td>
        <td className="px-4 py-3">
          <span className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-sh-gold/20 text-sh-gold">
            {batch.status}
          </span>
        </td>
      </tr>
      {expanded && batch.items && (
        <tr>
          <td colSpan={6} className="bg-sh-linen/50 px-6 py-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-sh-gray/20">
                  <th className="text-left px-3 py-2 text-sh-gray font-semibold">Barcode</th>
                  <th className="text-left px-3 py-2 text-sh-gray font-semibold">Quality</th>
                  <th className="text-left px-3 py-2 text-sh-gray font-semibold">Size</th>
                  <th className="text-right px-3 py-2 text-sh-gray font-semibold">Cost</th>
                  <th className="text-left px-3 py-2 text-sh-gray font-semibold">Sale Date</th>
                  <th className="text-left px-3 py-2 text-sh-gray font-semibold">Customer</th>
                </tr>
              </thead>
              <tbody>
                {batch.items.map((item) => (
                  <tr key={item.barcode} className="border-b border-sh-gray/10">
                    <td className="px-3 py-2 text-sh-black">{item.barcode}</td>
                    <td className="px-3 py-2 text-sh-black">{item.quality}</td>
                    <td className="px-3 py-2 text-sh-black">{item.size}</td>
                    <td className="px-3 py-2 text-sh-black text-right">{fmt(item.cost)}</td>
                    <td className="px-3 py-2 text-sh-black">{formatDate(item.saleDate)}</td>
                    <td className="px-3 py-2 text-sh-black">{item.saleCustomerName || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}
