"use client";

// /app/src/app/(dashboard)/app/inventory/consignment/receiving-gaps/ReceivingGapsView.tsx
//
// Consignment Receiving Gaps body: manager tool to fix data-quality gaps —
// items with no ConsignmentReceipt link, or no store location — via bulk
// assignment of a receipt and/or location. App Router port of the legacy
// inventory/consignment/receiving-gaps body (minus MainLayout chrome). Reads +
// mutates the shared /api/consignment/* + /api/warehouse/locations +
// /api/vendors REST endpoints; money uses the tenant formatter.

import { useState, useEffect, useCallback } from "react";
import axios from "axios";
import Link from "next/link";
import { toast } from "react-toastify";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";

type MoneyFormatter = ReturnType<typeof useMoneyFormatter>;

interface GapItem {
  id: number;
  barcode: string;
  customerNumber: string | null;
  quality: string | null;
  size: string | null;
  status: string;
  cost?: number;
  receivedDate?: string | null;
  consignmentReceiptId?: number | null;
  vendor: { name: string };
  selected: boolean;
}

interface ReceiptSummary {
  id: number;
  receiptDate: string;
  manifestRef: string | null;
  vendorName: string;
  claimedCount: number;
  actualCount: number;
}

interface StoreLocation {
  id: number;
  name: string;
  code: string;
}

interface Vendor {
  id: number;
  name: string;
}

interface Summary {
  unlinkedCount: number;
  unlocatedCount: number;
  receipts: ReceiptSummary[];
}

interface LinkReceiptBody {
  itemIds: number[];
  receiptId?: number;
  newReceiptDate?: string;
  newReceiptRef?: string;
  vendorId?: number;
}

type ActiveTab = "unlinked" | "unlocated";

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function ReceivingGapsView() {
  const fmt = useMoneyFormatter();

  const [tab, setTab] = useState<ActiveTab>("unlinked");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [items, setItems] = useState<GapItem[]>([]);
  const [locations, setLocations] = useState<StoreLocation[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Receipt assignment controls
  const [useExistingReceipt, setUseExistingReceipt] = useState(true);
  const [selectedReceiptId, setSelectedReceiptId] = useState<number | "">("");
  const [newReceiptDate, setNewReceiptDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [newReceiptRef, setNewReceiptRef] = useState("");
  const [newReceiptVendorId, setNewReceiptVendorId] = useState<number | "">("");

  // Location assignment control
  const [selectedLocationId, setSelectedLocationId] = useState<number | "">("");

  const loadSummary = useCallback(async () => {
    try {
      const res = await axios.get<Summary>("/api/consignment/receiving-gaps");
      setSummary(res.data);
    } catch {
      toast.error("Failed to load summary.");
    }
  }, []);

  const loadItems = useCallback(async (type: ActiveTab) => {
    setLoading(true);
    try {
      const res = await axios.get<{ items: GapItem[] }>(
        `/api/consignment/receiving-gaps?type=${type}&limit=500`,
      );
      setItems(res.data.items.map((i) => ({ ...i, selected: false })));
    } catch {
      toast.error("Failed to load items.");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadReferenceData = useCallback(async () => {
    try {
      const res = await axios.get<StoreLocation[]>("/api/warehouse/locations?isActive=true");
      setLocations(res.data || []);
    } catch {
      // Reference list is optional chrome; a failure should not block the page.
    }
    try {
      const res = await axios.get<{ vendors: Vendor[] }>("/api/vendors?all=true");
      setVendors(res.data.vendors || []);
    } catch {
      // Same — vendor list only powers the "create receipt" picker.
    }
  }, []);

  useEffect(() => {
    loadSummary();
    loadReferenceData();
  }, [loadSummary, loadReferenceData]);

  useEffect(() => {
    loadItems(tab);
  }, [tab, loadItems]);

  const toggleSelect = (id: number) => {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, selected: !i.selected } : i)));
  };

  const toggleAll = () => {
    const allSelected = items.length > 0 && items.every((i) => i.selected);
    setItems((prev) => prev.map((i) => ({ ...i, selected: !allSelected })));
  };

  const selectedItems = items.filter((i) => i.selected);

  const handleLinkReceipt = async () => {
    if (selectedItems.length === 0) {
      toast.warn("No items selected.");
      return;
    }
    if (useExistingReceipt && selectedReceiptId === "") {
      toast.warn("Select a receipt to link to.");
      return;
    }
    if (!useExistingReceipt && (!newReceiptDate || newReceiptVendorId === "")) {
      toast.warn("Receipt date and vendor are required.");
      return;
    }

    setSaving(true);
    try {
      const body: LinkReceiptBody = { itemIds: selectedItems.map((i) => i.id) };
      if (useExistingReceipt) {
        body.receiptId = selectedReceiptId as number;
      } else {
        body.newReceiptDate = newReceiptDate;
        body.newReceiptRef = newReceiptRef || undefined;
        body.vendorId = newReceiptVendorId as number;
      }

      const res = await axios.post<{ receiptId: number; linked: number }>(
        "/api/consignment/bulk-link-receipt",
        body,
      );
      toast.success(`Linked ${res.data.linked} item(s) to receipt #${res.data.receiptId}.`);
      await loadSummary();
      await loadItems(tab);
    } catch {
      toast.error("Failed to link items.");
    } finally {
      setSaving(false);
    }
  };

  const handleAssignLocation = async () => {
    if (selectedItems.length === 0) {
      toast.warn("No items selected.");
      return;
    }
    if (selectedLocationId === "") {
      toast.warn("Select a store location.");
      return;
    }

    setSaving(true);
    try {
      const res = await axios.post<{ assigned: number }>("/api/consignment/bulk-assign-location", {
        itemIds: selectedItems.map((i) => i.id),
        storeLocationId: selectedLocationId,
      });
      toast.success(`Assigned ${res.data.assigned} item(s) to location.`);
      await loadSummary();
      await loadItems(tab);
    } catch {
      toast.error("Failed to assign location.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/app/inventory/consignment" className="text-sh-blue hover:underline text-sm">
          Consignment
        </Link>
        <span className="text-sh-gray">/</span>
        <h1 className="text-2xl font-serif text-sh-navy">Receiving Gaps</h1>
      </div>

      {summary && <SummaryCards summary={summary} />}

      <div className="flex gap-1 border-b border-gray-200">
        {(["unlinked", "unlocated"] as ActiveTab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === t
                ? "border-sh-navy text-sh-navy"
                : "border-transparent text-sh-gray hover:text-sh-navy"
            }`}
          >
            {t === "unlinked" ? "No Receipt" : "No Location"}
          </button>
        ))}
      </div>

      {!loading && items.length > 0 && (
        <BulkActionPanel
          tab={tab}
          summary={summary}
          locations={locations}
          vendors={vendors}
          selectedCount={selectedItems.length}
          saving={saving}
          useExistingReceipt={useExistingReceipt}
          onUseExistingReceiptChange={setUseExistingReceipt}
          selectedReceiptId={selectedReceiptId}
          onSelectedReceiptIdChange={setSelectedReceiptId}
          newReceiptDate={newReceiptDate}
          onNewReceiptDateChange={setNewReceiptDate}
          newReceiptRef={newReceiptRef}
          onNewReceiptRefChange={setNewReceiptRef}
          newReceiptVendorId={newReceiptVendorId}
          onNewReceiptVendorIdChange={setNewReceiptVendorId}
          selectedLocationId={selectedLocationId}
          onSelectedLocationIdChange={setSelectedLocationId}
          onLinkReceipt={handleLinkReceipt}
          onAssignLocation={handleAssignLocation}
        />
      )}

      <GapItemsTable
        tab={tab}
        items={items}
        summary={summary}
        loading={loading}
        fmt={fmt}
        onToggleSelect={toggleSelect}
        onToggleAll={toggleAll}
      />
    </div>
  );
}

function SummaryCards({ summary }: Readonly<{ summary: Summary }>) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      <div className="rounded-lg border border-gray-200 bg-white p-4 text-center">
        <div className="text-2xl font-semibold text-amber-600">{summary.unlinkedCount}</div>
        <div className="text-xs text-sh-gray mt-1">No Receipt Link</div>
      </div>
      <div className="rounded-lg border border-gray-200 bg-white p-4 text-center">
        <div className="text-2xl font-semibold text-red-600">{summary.unlocatedCount}</div>
        <div className="text-xs text-sh-gray mt-1">No Store Location</div>
      </div>
      <div className="col-span-2 rounded-lg border border-gray-200 bg-sh-linen p-4">
        <div className="text-xs font-semibold text-sh-navy mb-2">Existing Receipts</div>
        {summary.receipts.length === 0 ? (
          <p className="text-xs text-sh-gray">None yet</p>
        ) : (
          <ul className="space-y-1">
            {summary.receipts.map((r) => (
              <li key={r.id} className="text-xs text-sh-gray">
                #{r.id} — {r.vendorName} — {formatDate(r.receiptDate)}{" "}
                {r.manifestRef ? `(${r.manifestRef}) ` : ""}
                <span className="font-medium text-sh-navy">{r.actualCount} items linked</span>
                {r.claimedCount !== r.actualCount && (
                  <span className="text-amber-600 ml-1">(header says {r.claimedCount})</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

interface BulkActionPanelProps {
  tab: ActiveTab;
  summary: Summary | null;
  locations: StoreLocation[];
  vendors: Vendor[];
  selectedCount: number;
  saving: boolean;
  useExistingReceipt: boolean;
  onUseExistingReceiptChange: (value: boolean) => void;
  selectedReceiptId: number | "";
  onSelectedReceiptIdChange: (value: number | "") => void;
  newReceiptDate: string;
  onNewReceiptDateChange: (value: string) => void;
  newReceiptRef: string;
  onNewReceiptRefChange: (value: string) => void;
  newReceiptVendorId: number | "";
  onNewReceiptVendorIdChange: (value: number | "") => void;
  selectedLocationId: number | "";
  onSelectedLocationIdChange: (value: number | "") => void;
  onLinkReceipt: () => void;
  onAssignLocation: () => void;
}

function BulkActionPanel(props: Readonly<BulkActionPanelProps>) {
  if (props.tab === "unlocated") {
    return (
      <div className="rounded-lg border border-gray-200 bg-sh-linen p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="gap-location" className="block text-xs text-sh-gray mb-1">
              Store Location ({props.selectedCount} selected)
            </label>
            <select
              id="gap-location"
              value={props.selectedLocationId}
              onChange={(e) =>
                props.onSelectedLocationIdChange(e.target.value ? Number(e.target.value) : "")
              }
              className="border border-gray-300 rounded px-3 min-h-[44px] text-sm"
            >
              <option value="">Select location…</option>
              {props.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
          <Button
            onClick={props.onAssignLocation}
            disabled={props.saving || props.selectedCount === 0}
            className="min-h-[44px]"
          >
            {props.saving ? "Saving…" : "Assign Location"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-sh-linen p-4">
      <div className="space-y-3">
        <div className="flex items-center gap-4 flex-wrap">
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="receipt-mode"
              checked={props.useExistingReceipt}
              onChange={() => props.onUseExistingReceiptChange(true)}
            />
            Use existing receipt
          </label>
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="receipt-mode"
              checked={!props.useExistingReceipt}
              onChange={() => props.onUseExistingReceiptChange(false)}
            />
            Create new receipt
          </label>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          {props.useExistingReceipt ? (
            <div>
              <label htmlFor="gap-existing-receipt" className="block text-xs text-sh-gray mb-1">
                Receipt ({props.selectedCount} selected)
              </label>
              <select
                id="gap-existing-receipt"
                value={props.selectedReceiptId}
                onChange={(e) =>
                  props.onSelectedReceiptIdChange(e.target.value ? Number(e.target.value) : "")
                }
                className="border border-gray-300 rounded px-3 min-h-[44px] text-sm"
              >
                <option value="">Select receipt…</option>
                {props.summary?.receipts.map((r) => (
                  <option key={r.id} value={r.id}>
                    #{r.id} — {r.vendorName} — {formatDate(r.receiptDate)} ({r.actualCount} linked)
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <NewReceiptFields
              vendors={props.vendors}
              selectedCount={props.selectedCount}
              newReceiptVendorId={props.newReceiptVendorId}
              onNewReceiptVendorIdChange={props.onNewReceiptVendorIdChange}
              newReceiptDate={props.newReceiptDate}
              onNewReceiptDateChange={props.onNewReceiptDateChange}
              newReceiptRef={props.newReceiptRef}
              onNewReceiptRefChange={props.onNewReceiptRefChange}
            />
          )}
          <Button
            onClick={props.onLinkReceipt}
            disabled={props.saving || props.selectedCount === 0}
            className="min-h-[44px]"
          >
            {props.saving ? "Saving…" : "Link to Receipt"}
          </Button>
        </div>
      </div>
    </div>
  );
}

interface NewReceiptFieldsProps {
  vendors: Vendor[];
  selectedCount: number;
  newReceiptVendorId: number | "";
  onNewReceiptVendorIdChange: (value: number | "") => void;
  newReceiptDate: string;
  onNewReceiptDateChange: (value: string) => void;
  newReceiptRef: string;
  onNewReceiptRefChange: (value: string) => void;
}

function NewReceiptFields(props: Readonly<NewReceiptFieldsProps>) {
  return (
    <>
      <div>
        <label htmlFor="gap-new-vendor" className="block text-xs text-sh-gray mb-1">
          Vendor
        </label>
        <select
          id="gap-new-vendor"
          value={props.newReceiptVendorId}
          onChange={(e) =>
            props.onNewReceiptVendorIdChange(e.target.value ? Number(e.target.value) : "")
          }
          className="border border-gray-300 rounded px-3 min-h-[44px] text-sm"
        >
          <option value="">Select vendor…</option>
          {props.vendors.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="gap-new-date" className="block text-xs text-sh-gray mb-1">
          Receipt Date ({props.selectedCount} selected)
        </label>
        <input
          id="gap-new-date"
          type="date"
          value={props.newReceiptDate}
          onChange={(e) => props.onNewReceiptDateChange(e.target.value)}
          className="border border-gray-300 rounded px-3 min-h-[44px] text-sm"
        />
      </div>
      <div>
        <label htmlFor="gap-new-ref" className="block text-xs text-sh-gray mb-1">
          Manifest Ref (optional)
        </label>
        <input
          id="gap-new-ref"
          type="text"
          value={props.newReceiptRef}
          onChange={(e) => props.onNewReceiptRefChange(e.target.value)}
          placeholder="e.g. FM-2023"
          className="border border-gray-300 rounded px-3 min-h-[44px] text-sm w-36"
        />
      </div>
    </>
  );
}

interface GapItemsTableProps {
  tab: ActiveTab;
  items: GapItem[];
  summary: Summary | null;
  loading: boolean;
  fmt: MoneyFormatter;
  onToggleSelect: (id: number) => void;
  onToggleAll: () => void;
}

function GapItemsTable({
  tab,
  items,
  summary,
  loading,
  fmt,
  onToggleSelect,
  onToggleAll,
}: Readonly<GapItemsTableProps>) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-sh-gold" />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <p className="text-center text-sm text-sh-gray py-10">
        {tab === "unlinked"
          ? "All items are linked to a receipt."
          : "All items have a store location assigned."}
      </p>
    );
  }

  const allSelected = items.length > 0 && items.every((i) => i.selected);
  const shownTotal = tab === "unlinked" ? summary?.unlinkedCount : summary?.unlocatedCount;

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200">
      <div className="px-4 py-2 bg-sh-linen text-xs text-sh-gray border-b border-gray-200">
        Showing {items.length} of {shownTotal} items
      </div>
      <table className="w-full text-sm">
        <thead className="bg-sh-linen border-b border-gray-200">
          <tr>
            <th className="px-3 py-3 text-left">
              <input
                type="checkbox"
                aria-label="Select all items"
                checked={allSelected}
                onChange={onToggleAll}
                className="h-5 w-5"
              />
            </th>
            <th className="px-3 py-3 text-left text-xs font-medium text-sh-gray">Barcode</th>
            <th className="px-3 py-3 text-left text-xs font-medium text-sh-gray">Cust #</th>
            <th className="px-3 py-3 text-left text-xs font-medium text-sh-gray">Quality</th>
            <th className="px-3 py-3 text-left text-xs font-medium text-sh-gray">Size</th>
            <th className="px-3 py-3 text-left text-xs font-medium text-sh-gray">Status</th>
            {tab === "unlinked" && (
              <th className="px-3 py-3 text-left text-xs font-medium text-sh-gray">Cost</th>
            )}
            {tab === "unlocated" && (
              <th className="px-3 py-3 text-left text-xs font-medium text-sh-gray">Receipt</th>
            )}
          </tr>
        </thead>
        <tbody>
          {items.map((item, i) => (
            <GapItemRow
              key={item.id}
              item={item}
              tab={tab}
              striped={i % 2 === 1}
              fmt={fmt}
              onToggleSelect={onToggleSelect}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface GapItemRowProps {
  item: GapItem;
  tab: ActiveTab;
  striped: boolean;
  fmt: MoneyFormatter;
  onToggleSelect: (id: number) => void;
}

function rowBackground(selected: boolean, striped: boolean): string {
  if (selected) return "bg-blue-50";
  return striped ? "bg-sh-stripe" : "bg-white";
}

function GapItemRow({ item, tab, striped, fmt, onToggleSelect }: Readonly<GapItemRowProps>) {
  return (
    <tr className={`border-b border-gray-100 ${rowBackground(item.selected, striped)}`}>
      <td className="px-3 py-2">
        <input
          type="checkbox"
          aria-label={`Select ${item.barcode}`}
          checked={item.selected}
          onChange={() => onToggleSelect(item.id)}
          className="h-5 w-5"
        />
      </td>
      <td className="px-3 py-2">
        <Link
          href={`/app/inventory/consignment/${item.id}`}
          className="font-mono text-sh-navy hover:underline text-xs"
        >
          {item.barcode}
        </Link>
      </td>
      <td className="px-3 py-2 text-sh-gray text-xs">{item.customerNumber || "—"}</td>
      <td className="px-3 py-2 text-sh-navy text-xs">{item.quality || "—"}</td>
      <td className="px-3 py-2 text-sh-gray text-xs">{item.size || "—"}</td>
      <td className="px-3 py-2 text-xs">{item.status}</td>
      {tab === "unlinked" && (
        <td className="px-3 py-2 text-sh-gray text-xs">
          {item.cost != null ? fmt(Number(item.cost), { whole: true }) : "—"}
        </td>
      )}
      {tab === "unlocated" && (
        <td className="px-3 py-2 text-sh-gray text-xs">
          {item.consignmentReceiptId ? `#${item.consignmentReceiptId}` : "—"}
        </td>
      )}
    </tr>
  );
}
