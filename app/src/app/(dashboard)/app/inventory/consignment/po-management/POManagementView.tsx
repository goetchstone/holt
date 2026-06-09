"use client";

// /app/src/app/(dashboard)/app/inventory/consignment/po-management/POManagementView.tsx
//
// Consignment PO Management body: pick sold rugs (positive) + post-payment
// credits (negative), see the net check amount, and either create a new payment
// batch or apply credits to an existing one. App Router port of the legacy
// inventory/consignment/po-management body (minus MainLayout chrome). Reads +
// mutates the shared /api/consignment/* REST endpoints; money uses the tenant
// formatter. Selection-sum math is copied verbatim from the legacy page.

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import axios from "axios";
import { toast } from "react-toastify";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { getErrorMessage } from "@/lib/toastError";

// Local alias for the tenant money formatter returned by useMoneyFormatter,
// so the table sub-components can receive it as a typed prop.
type MoneyFormatter = ReturnType<typeof useMoneyFormatter>;

interface UnassignedItem {
  id: number;
  barcode: string;
  customerNumber: string | null;
  quality: string | null;
  size: string | null;
  cost: number;
  saleDate: string | null;
  vendorId: number;
  vendorName: string | null;
  orderNumber: string | null;
  customerName: string | null;
}

interface CreditItem {
  id: number;
  barcode: string;
  customerNumber: string | null;
  quality: string | null;
  size: string | null;
  cost: number;
  status: string;
  paidDate: string | null;
  batchId: number | null;
  customerName: string | null;
  orderNumber: string | null;
  salesOrderId: number | null;
}

interface ExistingBatch {
  id: number;
  batchDate: string;
  checkNumber: string | null;
  totalAmount: number;
  itemCount: number;
  poNumber: string | null;
}

function formatDate(s: string | null): string {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function daysSince(s: string | null): number {
  if (!s) return 9999;
  return Math.floor((Date.now() - new Date(s).getTime()) / 86400000);
}

function ageBadgeClass(days: number): string {
  if (days > 60) return "bg-red-100 text-red-700";
  if (days > 14) return "bg-amber-100 text-amber-700";
  return "bg-green-100 text-green-700";
}

function AgeBadge({ date }: Readonly<{ date: string | null }>) {
  const days = daysSince(date);
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${ageBadgeClass(days)}`}
    >
      {days}d
    </span>
  );
}

// Row background: selection wins, then striping, else plain. Extracted so the
// JSX has no nested ternary.
function rowBg(selected: boolean, striped: boolean, selectedClass: string): string {
  if (selected) return selectedClass;
  if (striped) return "bg-sh-stripe";
  return "";
}

export function POManagementView() {
  const fmt = useMoneyFormatter();

  const [soldItems, setSoldItems] = useState<UnassignedItem[]>([]);
  const [loadingSold, setLoadingSold] = useState(true);
  const [selectedSold, setSelectedSold] = useState<Set<number>>(new Set());

  const [creditItems, setCreditItems] = useState<CreditItem[]>([]);
  const [loadingCredits, setLoadingCredits] = useState(true);
  const [selectedCredits, setSelectedCredits] = useState<Set<number>>(new Set());

  const [batches, setBatches] = useState<ExistingBatch[]>([]);

  const [checkNumber, setCheckNumber] = useState("");
  const [creating, setCreating] = useState(false);

  const [applyToBatchId, setApplyToBatchId] = useState<number | null>(null);
  const [applying, setApplying] = useState(false);

  const loadAll = useCallback(() => {
    setLoadingSold(true);
    setLoadingCredits(true);

    axios
      .get<{ items: UnassignedItem[] }>("/api/consignment/po-management/unassigned-sold")
      .then((r) => setSoldItems(r.data.items))
      .catch(() => toast.error("Failed to load sold items"))
      .finally(() => setLoadingSold(false));

    axios
      .get<{ items: CreditItem[] }>("/api/consignment/credits-owed")
      .then((r) => setCreditItems(r.data.items))
      .catch(() => toast.error("Failed to load credits"))
      .finally(() => setLoadingCredits(false));

    axios
      .get<{ batches: ExistingBatch[] }>("/api/consignment/payments")
      .then((r) => setBatches(r.data.batches))
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  function toggleSold(id: number) {
    setSelectedSold((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllSold() {
    if (selectedSold.size === soldItems.length) {
      setSelectedSold(new Set());
    } else {
      setSelectedSold(new Set(soldItems.map((i) => i.id)));
    }
  }

  function toggleCredit(id: number) {
    setSelectedCredits((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllCredits() {
    if (selectedCredits.size === creditItems.length) {
      setSelectedCredits(new Set());
    } else {
      setSelectedCredits(new Set(creditItems.map((i) => i.id)));
    }
  }

  const soldTotal = soldItems
    .filter((i) => selectedSold.has(i.id))
    .reduce((sum, i) => sum + i.cost, 0);
  const creditTotal = creditItems
    .filter((i) => selectedCredits.has(i.id))
    .reduce((sum, i) => sum + i.cost, 0);
  const netTotal = soldTotal - creditTotal;

  async function createBatch() {
    if (selectedSold.size === 0 && selectedCredits.size === 0) {
      toast.error("Select at least one item");
      return;
    }
    setCreating(true);
    try {
      const res = await axios.post("/api/consignment/po-management/assign-to-batch", {
        consignmentItemIds: Array.from(selectedSold),
        creditItemIds: Array.from(selectedCredits),
        checkNumber: checkNumber || undefined,
      });
      toast.success(
        `Payment batch created: ${res.data.soldCount} sold, ${res.data.creditCount} credits, net ${fmt(res.data.netTotal)}`,
      );
      setSelectedSold(new Set());
      setSelectedCredits(new Set());
      setCheckNumber("");
      loadAll();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to create payment batch"));
    } finally {
      setCreating(false);
    }
  }

  async function applyCreditsToExisting() {
    if (selectedCredits.size === 0 || !applyToBatchId) {
      toast.error("Select credits and a batch to apply to");
      return;
    }
    setApplying(true);
    try {
      const res = await axios.post("/api/consignment/po-management/apply-credits", {
        creditItemIds: Array.from(selectedCredits),
        batchId: applyToBatchId,
      });
      toast.success(
        `Applied ${res.data.creditCount} credits (${fmt(res.data.creditTotal)}) to batch. New total: ${fmt(res.data.newBatchTotal)}`,
      );
      setSelectedCredits(new Set());
      setApplyToBatchId(null);
      loadAll();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to apply credits"));
    } finally {
      setApplying(false);
    }
  }

  const loading = loadingSold || loadingCredits;
  const hasSelections = selectedSold.size > 0 || selectedCredits.size > 0;
  const soldGrandTotal = soldItems.reduce((s, i) => s + i.cost, 0);
  const creditGrandTotal = creditItems.reduce((s, i) => s + i.cost, 0);

  return (
    <div className="py-2 space-y-6 font-serif">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Link href="/app/inventory/consignment" className="text-sh-blue hover:underline text-sm">
            Consignment
          </Link>
          <span className="text-sh-gray">/</span>
          <h1 className="text-2xl font-semibold text-sh-blue">PO Management</h1>
        </div>
        <Link href="/app/inventory/consignment/payments">
          <Button variant="secondary" className="min-h-[44px]">
            Payment History
          </Button>
        </Link>
      </div>

      {!loading && (
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-white rounded-xl border border-sh-gray/15 p-4 text-center">
            <div className="text-xs text-sh-gray mb-1">Sold / Unpaid</div>
            <div className="text-2xl font-semibold text-sh-black">{soldItems.length}</div>
            <div className="text-sm text-sh-gray">{fmt(soldGrandTotal)}</div>
          </div>
          <div className="bg-white rounded-xl border border-sh-gray/15 p-4 text-center">
            <div className="text-xs text-sh-gray mb-1">Credits Owed</div>
            <div className="text-2xl font-semibold text-red-600">{creditItems.length}</div>
            <div className="text-sm text-red-600">-{fmt(creditGrandTotal)}</div>
          </div>
          <div className="bg-white rounded-xl border border-sh-gray/15 p-4 text-center">
            <div className="text-xs text-sh-gray mb-1">Net Owed to Vendor</div>
            <div className="text-2xl font-semibold text-sh-black">
              {fmt(soldGrandTotal - creditGrandTotal)}
            </div>
          </div>
        </div>
      )}

      <SoldTable
        items={soldItems}
        loading={loadingSold}
        selected={selectedSold}
        onToggle={toggleSold}
        onSelectAll={selectAllSold}
        fmt={fmt}
      />

      <CreditsTable
        items={creditItems}
        loading={loadingCredits}
        selected={selectedCredits}
        onToggle={toggleCredit}
        onSelectAll={selectAllCredits}
        batches={batches}
        applyToBatchId={applyToBatchId}
        onApplyToBatchIdChange={setApplyToBatchId}
        onApply={applyCreditsToExisting}
        applying={applying}
        fmt={fmt}
      />

      {hasSelections && (
        <div className="sticky bottom-4 bg-white rounded-xl border-2 border-sh-blue shadow-lg p-5 space-y-3">
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <div className="text-xs text-sh-gray">Sold ({selectedSold.size})</div>
              <div className="text-lg font-semibold text-sh-black">{fmt(soldTotal)}</div>
            </div>
            <div>
              <div className="text-xs text-sh-gray">Credits ({selectedCredits.size})</div>
              <div className="text-lg font-semibold text-red-600">-{fmt(creditTotal)}</div>
            </div>
            <div>
              <div className="text-xs text-sh-gray">Net (Check Amount)</div>
              <div className="text-lg font-semibold text-sh-blue">{fmt(netTotal)}</div>
            </div>
          </div>

          <div className="flex items-end gap-3 flex-wrap">
            <div>
              <label htmlFor="po-check-number" className="block text-xs text-sh-gray mb-1">
                Check Number
              </label>
              <input
                id="po-check-number"
                type="text"
                value={checkNumber}
                onChange={(e) => setCheckNumber(e.target.value)}
                placeholder="Optional"
                className="border border-sh-gray rounded-lg px-3 py-2 text-sm w-40 min-h-[44px]"
              />
            </div>
            <Button
              variant="primary"
              onClick={createBatch}
              disabled={creating}
              className="min-h-[44px]"
            >
              {creating && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Create Payment Batch
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

interface SoldTableProps {
  items: UnassignedItem[];
  loading: boolean;
  selected: Set<number>;
  onToggle: (id: number) => void;
  onSelectAll: () => void;
  fmt: MoneyFormatter;
}

function SoldTable({
  items,
  loading,
  selected,
  onToggle,
  onSelectAll,
  fmt,
}: Readonly<SoldTableProps>) {
  return (
    <div className="bg-white rounded-xl border border-sh-gray/15 p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-sh-blue">Sold Rugs — Owed to Vendor</h2>
        <span className="text-sm text-sh-gray">
          {items.length} item{items.length !== 1 ? "s" : ""}
        </span>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-5 h-5 animate-spin text-sh-blue mr-2" />
          <span className="text-sh-gray text-sm">Loading...</span>
        </div>
      )}
      {!loading && items.length === 0 && (
        <p className="text-sm text-sh-gray py-4 text-center">No unpaid sold rugs.</p>
      )}
      {!loading && items.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-sh-gray/15">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-sh-gray/20 bg-sh-linen">
                <th className="px-4 py-3 text-left">
                  <input
                    type="checkbox"
                    aria-label="Select all sold rugs"
                    checked={selected.size === items.length && items.length > 0}
                    onChange={onSelectAll}
                    className="w-5 h-5 accent-sh-blue"
                  />
                </th>
                <th className="text-left px-4 py-3 text-sh-gray font-semibold">Barcode</th>
                <th className="text-left px-4 py-3 text-sh-gray font-semibold">Description</th>
                <th className="text-left px-4 py-3 text-sh-gray font-semibold">Customer</th>
                <th className="text-left px-4 py-3 text-sh-gray font-semibold">Order</th>
                <th className="text-left px-4 py-3 text-sh-gray font-semibold">Sale Date</th>
                <th className="text-left px-4 py-3 text-sh-gray font-semibold">Age</th>
                <th className="text-right px-4 py-3 text-sh-gray font-semibold">Cost</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => (
                <tr
                  key={item.id}
                  className={`border-b border-sh-gray/10 cursor-pointer ${rowBg(
                    selected.has(item.id),
                    i % 2 === 1,
                    "bg-sh-blue/5",
                  )}`}
                  onClick={() => onToggle(item.id)}
                >
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      aria-label={`Select sold rug ${item.barcode}`}
                      checked={selected.has(item.id)}
                      onChange={() => onToggle(item.id)}
                      onClick={(e) => e.stopPropagation()}
                      className="w-5 h-5 accent-sh-blue"
                    />
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-sh-black">{item.barcode}</td>
                  <td className="px-4 py-3 text-sh-black text-xs">
                    {item.quality || "—"}
                    {item.size ? ` / ${item.size}` : ""}
                  </td>
                  <td className="px-4 py-3 text-sh-gray text-xs">{item.customerName || "—"}</td>
                  <td className="px-4 py-3 text-sh-blue text-xs">{item.orderNumber || "—"}</td>
                  <td className="px-4 py-3 text-sh-black text-xs">{formatDate(item.saleDate)}</td>
                  <td className="px-4 py-3">
                    <AgeBadge date={item.saleDate} />
                  </td>
                  <td className="px-4 py-3 text-right text-sh-black">{fmt(item.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

interface CreditsTableProps {
  items: CreditItem[];
  loading: boolean;
  selected: Set<number>;
  onToggle: (id: number) => void;
  onSelectAll: () => void;
  batches: ExistingBatch[];
  applyToBatchId: number | null;
  onApplyToBatchIdChange: (id: number | null) => void;
  onApply: () => void;
  applying: boolean;
  fmt: MoneyFormatter;
}

function CreditsTable({
  items,
  loading,
  selected,
  onToggle,
  onSelectAll,
  batches,
  applyToBatchId,
  onApplyToBatchIdChange,
  onApply,
  applying,
  fmt,
}: Readonly<CreditsTableProps>) {
  return (
    <div className="bg-white rounded-xl border border-sh-gray/15 p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-red-700">Credits Owed — Returns After Payment</h2>
        <span className="text-sm text-sh-gray">
          {items.length} item{items.length !== 1 ? "s" : ""}
        </span>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-5 h-5 animate-spin text-sh-blue mr-2" />
          <span className="text-sh-gray text-sm">Loading...</span>
        </div>
      )}
      {!loading && items.length === 0 && (
        <p className="text-sm text-sh-gray py-4 text-center">No credits owed.</p>
      )}
      {!loading && items.length > 0 && (
        <>
          <div className="overflow-hidden rounded-lg border border-sh-gray/15">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-sh-gray/20 bg-sh-linen">
                  <th className="px-4 py-3 text-left">
                    <input
                      type="checkbox"
                      aria-label="Select all credits"
                      checked={selected.size === items.length && items.length > 0}
                      onChange={onSelectAll}
                      className="w-5 h-5 accent-sh-blue"
                    />
                  </th>
                  <th className="text-left px-4 py-3 text-sh-gray font-semibold">Barcode</th>
                  <th className="text-left px-4 py-3 text-sh-gray font-semibold">Description</th>
                  <th className="text-left px-4 py-3 text-sh-gray font-semibold">Customer</th>
                  <th className="text-left px-4 py-3 text-sh-gray font-semibold">Paid Date</th>
                  <th className="text-left px-4 py-3 text-sh-gray font-semibold">Status</th>
                  <th className="text-right px-4 py-3 text-sh-gray font-semibold">Credit</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, i) => (
                  <tr
                    key={item.id}
                    className={`border-b border-sh-gray/10 cursor-pointer ${rowBg(
                      selected.has(item.id),
                      i % 2 === 1,
                      "bg-red-50",
                    )}`}
                    onClick={() => onToggle(item.id)}
                  >
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        aria-label={`Select credit ${item.barcode}`}
                        checked={selected.has(item.id)}
                        onChange={() => onToggle(item.id)}
                        onClick={(e) => e.stopPropagation()}
                        className="w-5 h-5 accent-sh-blue"
                      />
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-sh-black">{item.barcode}</td>
                    <td className="px-4 py-3 text-sh-black text-xs">
                      {item.quality || "—"}
                      {item.size ? ` / ${item.size}` : ""}
                    </td>
                    <td className="px-4 py-3 text-sh-gray text-xs">{item.customerName || "—"}</td>
                    <td className="px-4 py-3 text-sh-black text-xs">{formatDate(item.paidDate)}</td>
                    <td className="px-4 py-3">
                      <span className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-sh-blue/10 text-sh-blue">
                        {item.status.replace("_", " ")}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-red-600 font-semibold">
                      -{fmt(item.cost)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {selected.size > 0 && (
            <div className="bg-amber-50 rounded-lg p-4 space-y-2">
              <span className="text-sm font-semibold text-amber-800">
                Apply selected credits to an existing payment batch:
              </span>
              <div className="flex items-end gap-3 flex-wrap">
                <select
                  aria-label="Existing payment batch"
                  value={applyToBatchId ?? ""}
                  onChange={(e) =>
                    onApplyToBatchIdChange(e.target.value ? Number.parseInt(e.target.value) : null)
                  }
                  className="border border-sh-gray rounded-lg px-3 py-2 text-sm w-64 bg-white min-h-[44px]"
                >
                  <option value="">Select a batch...</option>
                  {batches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {formatDate(b.batchDate)} — {b.checkNumber || "No check #"} (
                      {fmt(b.totalAmount)})
                    </option>
                  ))}
                </select>
                <Button
                  variant="secondary"
                  onClick={onApply}
                  disabled={applying || !applyToBatchId}
                  className="min-h-[44px]"
                >
                  {applying && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  Apply Credits to Batch
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
