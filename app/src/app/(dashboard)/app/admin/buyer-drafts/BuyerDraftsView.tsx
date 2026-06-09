"use client";

// /app/src/app/(dashboard)/app/admin/buyer-drafts/BuyerDraftsView.tsx
//
// Buyer's drafts workbench body. App Router port of the legacy
// admin/buyer-drafts/index.tsx (minus MainLayout chrome, which the (dashboard)
// layout supplies). Card-based layout — items as roomy cards in a grid, PO + Buy
// sidebar with bigger hit targets. "Add item" opens the DraftItemWizard. Two
// @dnd-kit drag axes drive reassignment: item→PO (item-<n> over po-<n> /
// po-unassigned, PATCHes draftPoId) and PO→Buy (po-<n> over buy-<n> /
// buy-unassigned, PATCHes buyId). Reads the shared /api/admin/buyer-drafts/*
// REST endpoints, which stay REST.

import { useState, useEffect, useMemo, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import axios from "axios";
import { toast } from "react-toastify";
import { Download, Plus, Loader2, ScanBarcode } from "lucide-react";
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { Button } from "@/components/ui/button";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { getErrorMessage } from "@/lib/toastError";
import DraftItemWizard from "@/components/buyer-drafts/DraftItemWizard";
import DraftPoModal, { type EditingPo } from "@/components/buyer-drafts/DraftPoModal";
import DraftBuyModal, { type EditingBuy } from "@/components/buyer-drafts/DraftBuyModal";
import BarcodeLookupModal from "@/components/buyer-drafts/BarcodeLookupModal";
import { HistoricalPoImportModal } from "@/components/admin/buyer-drafts/HistoricalPoImportModal";
import { parseDragTarget } from "@/lib/buyerDraftDnd";
import { isCompatiblePoForItem } from "@/lib/buyerDraftValidation";
import {
  STATUSES,
  formatBuyOptionLabel,
  type Category,
  type Department,
  type DraftBuy,
  type DraftItem,
  type DraftPo,
  type IdOrAllOrUnassigned,
  type StockLocation,
  type StoreLocation,
  type Status,
  type Type,
  type Vendor,
} from "./types";
import { passesItemFilters } from "./itemFilters";
import { itemToFormState } from "./itemFormState";
import { FilterDropdown } from "./FilterDropdown";
import { DraggableItemCard } from "./ItemCard";
import { DraftPosPanel } from "./DraftPosPanel";
import { BuysPanel } from "./BuysPanel";

interface LookupsResponse {
  vendors: Vendor[];
  stockLocations: StockLocation[];
  storeLocations: StoreLocation[];
  departments: Department[];
  categories: Category[];
  types: Type[];
  buys: DraftBuy[];
}

export function BuyerDraftsView() {
  const searchParams = useSearchParams();
  const formatMoney = useMoneyFormatter();

  const [items, setItems] = useState<DraftItem[]>([]);
  const [pos, setPos] = useState<DraftPo[]>([]);
  const [buys, setBuys] = useState<DraftBuy[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [types, setTypes] = useState<Type[]>([]);
  const [stockLocations, setStockLocations] = useState<StockLocation[]>([]);
  const [storeLocations, setStoreLocations] = useState<StoreLocation[]>([]);

  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<Status | "ALL">("DRAFT");
  const [vendorFilter, setVendorFilter] = useState<number | "ALL">("ALL");
  const [poFilter, setPoFilter] = useState<IdOrAllOrUnassigned>("ALL");
  const [buyFilter, setBuyFilter] = useState<IdOrAllOrUnassigned>("ALL");

  // Wizard state
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardEditingId, setWizardEditingId] = useState<number | null>(null);
  const [wizardPrefill, setWizardPrefill] = useState<Record<string, unknown> | null>(null);

  // PO + barcode + buy modal state
  const [poModalOpen, setPoModalOpen] = useState(false);
  const [poModalEditing, setPoModalEditing] = useState<EditingPo | null>(null);
  const [barcodeModalOpen, setBarcodeModalOpen] = useState(false);
  const [buyModalOpen, setBuyModalOpen] = useState(false);
  const [buyModalEditing, setBuyModalEditing] = useState<EditingBuy | null>(null);

  // Slice 6.13 (2026-05-22) — Historical PO import. Modal state is page-level so
  // a single instance handles every Buy's "Import historical PO" button.
  const [historicalImportOpen, setHistoricalImportOpen] = useState(false);
  const [historicalImportTarget, setHistoricalImportTarget] = useState<{
    id: number;
    name: string;
  } | null>(null);

  // ── Load all data ───────────────────────────────────────────────────

  const loadAll = useCallback(async () => {
    try {
      setLoading(true);
      const [itemsRes, posRes, lookupsRes] = await Promise.all([
        axios.get<{ items: DraftItem[] }>("/api/admin/buyer-drafts/items"),
        axios.get<{ pos: DraftPo[] }>("/api/admin/buyer-drafts/pos"),
        axios.get<LookupsResponse>("/api/admin/buyer-drafts/lookups"),
      ]);
      setItems(itemsRes.data.items ?? []);
      setPos(posRes.data.pos ?? []);
      setVendors(lookupsRes.data.vendors ?? []);
      setDepartments(lookupsRes.data.departments ?? []);
      setCategories(lookupsRes.data.categories ?? []);
      setTypes(lookupsRes.data.types ?? []);
      setStockLocations(lookupsRes.data.stockLocations ?? []);
      setStoreLocations(lookupsRes.data.storeLocations ?? []);
      setBuys(lookupsRes.data.buys ?? []);
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to load drafts"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // 2026-05-13 — pick up ?buyId=N from the archive page's "Items" link so the
  // buyer lands here pre-filtered to the closed buy whose items they want to
  // inspect. Also widen status to ALL since closed buys hold EXPORTED /
  // FULFILLED items, not DRAFT.
  useEffect(() => {
    const raw = searchParams?.get("buyId");
    if (!raw) return;
    const n = Number.parseInt(raw, 10);
    if (Number.isInteger(n) && n > 0) {
      setBuyFilter(n);
      setStatusFilter("ALL");
    }
  }, [searchParams]);

  // ── Derived maps + filtering ────────────────────────────────────────

  // poId → buyId, so the items-by-buy filter can resolve an item's buy through
  // its draftPoId (items don't carry buyId directly).
  const poToBuy = useMemo(() => {
    const m = new Map<number, number | null>();
    for (const p of pos) m.set(p.id, p.buyId);
    return m;
  }, [pos]);

  // Live PO → item count from `items` state so the "N items" badge updates
  // instantly on drag-drop instead of waiting for the server's _count refresh.
  const itemCountByPo = useMemo(() => {
    const m = new Map<number, number>();
    for (const it of items) {
      if (it.draftPoId === null || it.draftPoId === undefined) continue;
      m.set(it.draftPoId, (m.get(it.draftPoId) ?? 0) + 1);
    }
    return m;
  }, [items]);

  // Live PO → total cost (cost × qty across items in the PO).
  const itemTotalCostByPo = useMemo(() => {
    const m = new Map<number, number>();
    for (const it of items) {
      if (it.draftPoId === null || it.draftPoId === undefined) continue;
      const cost = Number(it.cost ?? 0);
      const qty = Number(it.qty ?? 0);
      if (!Number.isFinite(cost) || !Number.isFinite(qty)) continue;
      m.set(it.draftPoId, (m.get(it.draftPoId) ?? 0) + cost * qty);
    }
    return m;
  }, [items]);

  const filteredItems = useMemo(() => {
    return items.filter((item) =>
      passesItemFilters(item, { statusFilter, vendorFilter, poFilter, buyFilter, poToBuy }),
    );
  }, [items, statusFilter, vendorFilter, poFilter, buyFilter, poToBuy]);

  // Per-Buy rollup: total spent (sum of qty × cost across all items in POs
  // under each Buy). Drives the Buys panel's progress bars.
  const buyRollup = useMemo(() => {
    const spent = new Map<number, number>();
    for (const item of items) {
      if (item.draftPoId === null) continue;
      const buyId = poToBuy.get(item.draftPoId);
      if (buyId === null || buyId === undefined) continue;
      const cost = Number(item.cost) || 0;
      spent.set(buyId, (spent.get(buyId) ?? 0) + item.qty * cost);
    }
    return spent;
  }, [items, poToBuy]);

  // ── Wizard handlers ─────────────────────────────────────────────────

  const handleOpenWizardForNew = () => {
    setWizardEditingId(null);
    setWizardPrefill(null);
    setWizardOpen(true);
  };

  const handleEdit = (item: DraftItem) => {
    setWizardEditingId(item.id);
    setWizardPrefill(itemToFormState(item));
    setWizardOpen(true);
  };

  const handleDuplicate = (item: DraftItem) => {
    setWizardEditingId(null);
    // Copy everything except the per-item identity (force a new part #).
    const prefill = itemToFormState(item);
    prefill.partNumber = "";
    prefill.productName = "";
    setWizardPrefill(prefill);
    setWizardOpen(true);
  };

  const handleWizardSaved = () => {
    void loadAll();
  };

  // ── Item delete ─────────────────────────────────────────────────────

  const handleDelete = async (id: number) => {
    if (!globalThis.confirm("Delete this draft item? This cannot be undone.")) return;
    try {
      await axios.delete(`/api/admin/buyer-drafts/items/${id}`);
      setItems((prev) => prev.filter((it) => it.id !== id));
      toast.success("Item deleted");
    } catch (err) {
      toast.error(getErrorMessage(err, "Delete failed"));
    }
  };

  // ── PO actions ──────────────────────────────────────────────────────

  const handleOpenPoModalForNew = () => {
    setPoModalEditing(null);
    setPoModalOpen(true);
  };

  const handleOpenPoModalForEdit = (po: DraftPo) => {
    setPoModalEditing({
      id: po.id,
      vendorId: po.vendorId,
      vendorName: po.vendorName,
      referenceNumber: po.referenceNumber,
      expectedShipMonth: po.expectedShipMonth,
      storeLocationId: po.storeLocationId,
      buyId: po.buyId,
      status: po.status,
    });
    setPoModalOpen(true);
  };

  // ── Buy actions (slice 4-buys) ──────────────────────────────────────

  const handleOpenBuyModalForNew = () => {
    setBuyModalEditing(null);
    setBuyModalOpen(true);
  };

  const handleOpenBuyModalForEdit = (b: DraftBuy) => {
    setBuyModalEditing({
      id: b.id,
      name: b.name,
      season: b.season,
      year: b.year,
      budget: b.budget,
      status: b.status,
    });
    setBuyModalOpen(true);
  };

  const handleOpenHistoricalImport = (b: DraftBuy) => {
    setHistoricalImportTarget({ id: b.id, name: b.name });
    setHistoricalImportOpen(true);
  };
  const handleCloseHistoricalImport = () => {
    setHistoricalImportOpen(false);
    setHistoricalImportTarget(null);
  };

  // ── Drag-and-drop ───────────────────────────────────────────────────

  const pointerSensor = useSensor(PointerSensor, { activationConstraint: { distance: 8 } });
  const touchSensor = useSensor(TouchSensor, {
    activationConstraint: { delay: 200, tolerance: 5 },
  });
  const dndSensors = useSensors(pointerSensor, touchSensor);

  // Move an item card to a PO sidebar card (or unassigned). Optimistic local
  // update; rollback on PATCH failure. Pre-checks vendor match via
  // isCompatiblePoForItem so a cross-vendor drop fails fast instead of 400ing.
  const moveItemToPo = useCallback(
    async (itemId: number, nextPoId: number | null) => {
      const item = items.find((it) => it.id === itemId);
      const before = item?.draftPoId ?? null;
      if (before === nextPoId) return;

      // Cross-vendor guard. Only relevant when moving INTO a PO (drop to
      // unassigned is always allowed).
      if (nextPoId !== null && item) {
        const targetPo = pos.find((p) => p.id === nextPoId);
        if (targetPo) {
          const compat = isCompatiblePoForItem(
            { vendorId: item.vendorId ?? null },
            { vendorId: targetPo.vendorId ?? null },
          );
          if (!compat.ok) {
            toast.warn(compat.reason);
            return; // don't even attempt the PATCH
          }
        }
      }

      setItems((prev) =>
        prev.map((it) => (it.id === itemId ? { ...it, draftPoId: nextPoId } : it)),
      );

      try {
        await axios.patch(`/api/admin/buyer-drafts/items/${itemId}`, { draftPoId: nextPoId });
        toast.success(nextPoId === null ? "Item unassigned from PO" : "Item moved to PO");
      } catch (err) {
        setItems((prev) =>
          prev.map((it) => (it.id === itemId ? { ...it, draftPoId: before } : it)),
        );
        toast.error(getErrorMessage(err, "Failed to move item"));
      }
    },
    [items, pos],
  );

  // Move a PO sidebar card to a Buy (or unassigned). Optimistic; rollback on fail.
  const movePoToBuy = useCallback(
    async (poId: number, nextBuyId: number | null) => {
      const before = pos.find((p) => p.id === poId)?.buyId ?? null;
      if (before === nextBuyId) return;

      setPos((prev) => prev.map((p) => (p.id === poId ? { ...p, buyId: nextBuyId } : p)));

      try {
        await axios.patch(`/api/admin/buyer-drafts/pos/${poId}`, { buyId: nextBuyId });
        toast.success(nextBuyId === null ? "PO unassigned from buy" : "PO moved to buy");
      } catch (err) {
        setPos((prev) => prev.map((p) => (p.id === poId ? { ...p, buyId: before } : p)));
        toast.error(getErrorMessage(err, "Failed to move PO"));
      }
    },
    [pos],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const target = parseDragTarget(event);
      if (target === null) return;
      if (target.kind === "item-to-po") void moveItemToPo(target.itemId, target.nextPoId);
      else if (target.kind === "po-to-buy") void movePoToBuy(target.poId, target.nextBuyId);
    },
    [moveItemToPo, movePoToBuy],
  );

  // ── Export ──────────────────────────────────────────────────────────
  //
  // Pass the current page filters through to the export URL so the download
  // honors the same scope the buyer is looking at. The helper
  // lib/buyerDraftExportFilters.ts drops the READY default server-side when
  // `buyId` or `ids` is present (fixes the empty-CSV-against-CLOSED-buy bug).

  const handleExport = (kind: "items" | "pos" | "workbook") => {
    const params = new URLSearchParams();
    if (typeof buyFilter === "number") {
      params.set("buyId", String(buyFilter));
    } else if (buyFilter === "UNASSIGNED") {
      params.set("buyId", "unassigned");
    }
    if (statusFilter !== "ALL") {
      params.set("status", statusFilter);
    }
    if (typeof vendorFilter === "number") {
      params.set("vendorId", String(vendorFilter));
    }
    const qs = params.toString();
    const url = qs
      ? `/api/admin/buyer-drafts/export/${kind}?${qs}`
      : `/api/admin/buyer-drafts/export/${kind}`;
    globalThis.location.assign(url);
  };

  // ── Render ──────────────────────────────────────────────────────────

  return (
    <div className="px-6 py-8 max-w-screen-xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <h1 className="font-serif text-3xl text-sh-navy">Buyer Drafts</h1>
        <p className="text-sm text-sh-gray mt-2 max-w-3xl">
          Workbench for new items + POs. Drafts here aren&apos;t live products — they live here
          while specs are being negotiated, then export to the POS-import-format CSVs. Once the POS
          imports them and the items flow back through Stock-by-Item, drafts auto-link to the real
          Product records.
        </p>
      </div>

      {/* Action bar */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <Button onClick={handleOpenWizardForNew} className="bg-sh-gold text-white min-h-[44px]">
          <Plus className="h-4 w-4 mr-1" /> Add item
        </Button>
        <Button
          onClick={() => setBarcodeModalOpen(true)}
          variant="secondary"
          className="min-h-[44px]"
        >
          <ScanBarcode className="h-4 w-4 mr-1" /> Quick add (barcode)
        </Button>
        <Button onClick={handleOpenPoModalForNew} variant="secondary" className="min-h-[44px]">
          <Plus className="h-4 w-4 mr-1" /> New draft PO
        </Button>
        <Button onClick={handleOpenBuyModalForNew} variant="secondary" className="min-h-[44px]">
          <Plus className="h-4 w-4 mr-1" /> New buy
        </Button>
        <div className="flex-1" />
        <Button
          onClick={() => handleExport("workbook")}
          className="bg-sh-blue text-white min-h-[44px]"
          title="Buyer-side review workbook with per-vendor sheets, TOTAL pivot, and Floor Plan by vignette"
        >
          <Download className="h-4 w-4 mr-1" /> Buyer Workbook (XLSX)
        </Button>
        <Button
          onClick={() => handleExport("items")}
          variant="secondary"
          className="min-h-[44px]"
          title="the POS-format items import. Respects the current Buy / Status / Vendor filters. With no filter set, defaults to READY items and stamps them EXPORTED for the production handoff."
        >
          <Download className="h-4 w-4 mr-1" /> Items CSV
        </Button>
        <Button
          onClick={() => handleExport("pos")}
          variant="secondary"
          className="min-h-[44px]"
          title="the POS-format POs import. Respects the current Buy / Status / Vendor filters. With no filter set, defaults to READY POs and stamps them EXPORTED."
        >
          <Download className="h-4 w-4 mr-1" /> POs CSV
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-4 mb-6 p-4 bg-sh-stripe/40 rounded-lg">
        <FilterDropdown
          label="Status"
          value={statusFilter}
          onChange={(v) => setStatusFilter(v as Status | "ALL")}
          options={[
            { value: "ALL", label: "All statuses" },
            ...STATUSES.map((s) => ({ value: s, label: s })),
          ]}
        />
        <FilterDropdown
          label="Vendor"
          value={String(vendorFilter)}
          onChange={(v) => setVendorFilter(v === "ALL" ? "ALL" : Number(v))}
          options={[
            { value: "ALL", label: "All vendors" },
            ...vendors.map((v) => ({ value: String(v.id), label: v.name })),
          ]}
        />
        <FilterDropdown
          label="PO"
          value={String(poFilter)}
          onChange={(v) => {
            if (v === "ALL" || v === "UNASSIGNED") setPoFilter(v);
            else setPoFilter(Number(v));
          }}
          options={[
            { value: "ALL", label: "All POs" },
            { value: "UNASSIGNED", label: "Unassigned" },
            ...pos.map((p) => ({
              value: String(p.id),
              label: `${p.referenceNumber ?? "(no ref)"} — ${p.vendor?.name ?? p.vendorName}`,
            })),
          ]}
        />
        <FilterDropdown
          label="Buy"
          value={String(buyFilter)}
          onChange={(v) => {
            if (v === "ALL" || v === "UNASSIGNED") setBuyFilter(v);
            else setBuyFilter(Number(v));
          }}
          options={[
            { value: "ALL", label: "All buys" },
            { value: "UNASSIGNED", label: "Unassigned" },
            ...buys.map((b) => ({ value: String(b.id), label: formatBuyOptionLabel(b) })),
          ]}
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="h-8 w-8 animate-spin text-sh-gold" />
        </div>
      ) : (
        <DndContext sensors={dndSensors} onDragEnd={handleDragEnd}>
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
            {/* Items as cards */}
            <div>
              {filteredItems.length === 0 ? (
                <div className="text-center py-16 bg-white border border-sh-stripe rounded-lg">
                  <p className="text-sh-gray">No items match this filter.</p>
                  <Button
                    onClick={handleOpenWizardForNew}
                    variant="secondary"
                    className="mt-4 min-h-[44px]"
                  >
                    <Plus className="h-4 w-4 mr-1" /> Add your first item
                  </Button>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {filteredItems.map((item) => (
                    <DraggableItemCard
                      key={item.id}
                      item={item}
                      formatMoney={formatMoney}
                      onEdit={() => handleEdit(item)}
                      onDuplicate={() => handleDuplicate(item)}
                      onDelete={() => handleDelete(item.id)}
                    />
                  ))}
                </div>
              )}
              <div className="mt-3 text-xs text-sh-gray">
                {filteredItems.length} item{filteredItems.length === 1 ? "" : "s"} shown
                {items.length > filteredItems.length && ` (${items.length} total)`}
                {pos.length > 0 && (
                  <span className="ml-2">· drag a card to a PO on the right to assign it</span>
                )}
              </div>
            </div>

            {/* Sidebar: Buys above, Draft POs below */}
            <aside className="space-y-4 h-fit">
              <BuysPanel
                buys={buys}
                buyRollup={buyRollup}
                buyFilter={buyFilter}
                formatMoney={formatMoney}
                onSelect={(id) => setBuyFilter(buyFilter === id ? "ALL" : id)}
                onEdit={handleOpenBuyModalForEdit}
                onImportHistorical={handleOpenHistoricalImport}
              />
              <DraftPosPanel
                pos={pos}
                buys={buys}
                buyFilter={buyFilter}
                poFilter={poFilter}
                itemCountByPo={itemCountByPo}
                itemTotalCostByPo={itemTotalCostByPo}
                onSelect={(id) => setPoFilter(id)}
                onEdit={handleOpenPoModalForEdit}
              />
            </aside>
          </div>
        </DndContext>
      )}

      {/* Wizard */}
      <DraftItemWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onSaved={handleWizardSaved}
        vendors={vendors}
        departments={departments}
        categories={categories}
        types={types}
        stockLocations={stockLocations}
        draftPos={pos}
        editingItemId={wizardEditingId}
        prefill={wizardPrefill as never}
      />

      {/* PO modal — used for both create and edit */}
      <DraftPoModal
        open={poModalOpen}
        onClose={() => setPoModalOpen(false)}
        onSaved={() => void loadAll()}
        vendors={vendors}
        storeLocations={storeLocations}
        buys={buys}
        editingPo={poModalEditing}
      />

      {/* Buy modal — used for both create and edit */}
      <DraftBuyModal
        open={buyModalOpen}
        onClose={() => setBuyModalOpen(false)}
        onSaved={() => void loadAll()}
        editingBuy={buyModalEditing}
      />

      {/* Slice 4.5: barcode quick-add */}
      <BarcodeLookupModal
        open={barcodeModalOpen}
        onClose={() => setBarcodeModalOpen(false)}
        onCreated={() => void loadAll()}
      />

      <HistoricalPoImportModal
        open={historicalImportOpen}
        buyId={historicalImportTarget?.id ?? null}
        buyName={historicalImportTarget?.name ?? null}
        onClose={handleCloseHistoricalImport}
        onImported={() => void loadAll()}
      />
    </div>
  );
}
