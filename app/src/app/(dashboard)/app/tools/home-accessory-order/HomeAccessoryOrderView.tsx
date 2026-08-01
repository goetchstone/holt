"use client";

// /app/src/app/(dashboard)/app/tools/home-accessory-order/HomeAccessoryOrderView.tsx
//
// Home Accessory Order Import — parse a home-accessory vendor order file
// (PDF, or a CSV for Simblist Group) and create BuyerDraftPurchaseOrder +
// BuyerDraftItem rows from it. Ported from furniture-configurator's
// pages/tools/home-accessory-order.tsx and ADAPTED to holt's native Buyer
// Drafts pipeline: FC downloaded Ordorite import CSVs here (files-only,
// Ordorite is FC's system of record); holt writes DB rows directly (holt IS
// its own system of record) via POST /api/tools/home-accessory-order/commit.
//
// Preserved from FC: per-ITEM department + category classification,
// buyer-driven set splitting with cost reconciliation, optional markup ->
// selling + MSRP, multi-PO bundles (one draft PO per distinct order
// reference), one card per item with split-group visual grouping.
//
// Dropped relative to FC (see homeAccessoryRows.ts / homeAccessoryOrders.ts
// for the full rationale): the Ordorite catalog-match / "adopt the
// catalog's existing split" flow (no holt analog — buyer drafts are
// pre-catalog negotiation records) and the Oversell field (no
// BuyerDraftItem column for it).

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "react-toastify";
import { Upload, PackagePlus, RotateCcw, Scissors, Undo2 } from "lucide-react";
import {
  HOME_ACCESSORY_FORMATS,
  SPLIT_PRESETS,
  defaultSplitPercents,
  sameSupplier,
  splitCostsByPercent,
  type HomeAccessoryDraft,
  type HomeAccessoryFormatId,
} from "@/lib/homeAccessoryOrders";
import {
  composeHomeAccessoryRows,
  groupRowsForRender,
  type CatOption,
  type DeptOption,
  type EffectiveRow,
  type RenderBlock,
  type SplitPart,
} from "@/lib/homeAccessoryRows";
import {
  poReconciliationTotal,
  composedTotal,
  unclassifiedRowCount,
} from "@/lib/homeAccessoryBuyerDraftMapping";
import { readServerError } from "@/lib/toolFileUtils";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { usePersistentFilters } from "@/hooks/usePersistentFilters";
import { Button } from "@/components/ui/button";

interface StockLocationOption {
  id: number;
  code: string;
  name: string;
}
interface VendorOption {
  id: number;
  name: string;
  code: string | null;
}
interface BuyOption {
  id: number;
  name: string;
  season: string | null;
  year: number | null;
  status: string;
}

interface PersistedDefaults {
  departmentId: number | null;
  categoryId: number | null;
  stockLocationId: number | null;
  markup: string;
  stockFamily: string;
  buyId: number | null;
}

interface CommitResult {
  poCount: number;
  itemCount: number;
  unassignedCount: number;
  pos: { id: number; referenceNumber: string | null }[];
}

function defaultSuffixes(parts: number): string[] {
  if (parts === 2) return ["LG", "SM"];
  if (parts === 3) return ["LG", "MD", "SM"];
  return Array.from({ length: parts }, (_, i) => String(i + 1));
}
function partsFromPercents(setPrice: number, suffixes: readonly string[], percents: number[]) {
  const costs = splitCostsByPercent(setPrice, percents);
  return suffixes.map((suffix, i) => ({ suffix, cost: String(costs[i] ?? 0) }));
}

export function HomeAccessoryOrderView() {
  const router = useRouter();
  const fmt = useMoneyFormatter();

  const [format, setFormat] = useState<HomeAccessoryFormatId>("kk-interiors");
  const [loading, setLoading] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [draft, setDraft] = useState<HomeAccessoryDraft | null>(null);
  const [result, setResult] = useState<CommitResult | null>(null);

  const [departments, setDepartments] = useState<DeptOption[]>([]);
  const [categories, setCategories] = useState<CatOption[]>([]);
  const [stockLocations, setStockLocations] = useState<StockLocationOption[]>([]);
  const [vendors, setVendors] = useState<VendorOption[]>([]);
  const [buys, setBuys] = useState<BuyOption[]>([]);
  const [supplier, setSupplier] = useState("");
  // Not sticky: a pre-set-up PO belongs to one order, never the next one.
  const [poNumbers, setPoNumbers] = useState<Record<string, string>>({});

  // Per-row edits, keyed by EffectiveRow.key so split children keep their own.
  const [splits, setSplits] = useState<Record<number, SplitPart[]>>({});
  const [rowDepts, setRowDepts] = useState<Record<string, number>>({});
  const [rowCats, setRowCats] = useState<Record<string, number>>({});
  const [sellings, setSellings] = useState<Record<string, string>>({});
  const [msrps, setMsrps] = useState<Record<string, string>>({});
  const [names, setNames] = useState<Record<string, string>>({});
  const [descriptions, setDescriptions] = useState<Record<string, string>>({});
  const [barcodes, setBarcodes] = useState<Record<string, string>>({});
  const [poExcluded, setPoExcluded] = useState<Record<string, boolean>>({});
  const [partNumbers, setPartNumbers] = useState<Record<string, string>>({});

  const [defaults, setDefaults] = usePersistentFilters<PersistedDefaults>(
    "home-accessory-order-defaults",
    {
      departmentId: null,
      categoryId: null,
      stockLocationId: null,
      markup: "",
      stockFamily: "",
      buyId: null,
    },
  );

  useEffect(() => {
    fetch("/api/admin/buyer-drafts/lookups")
      .then((res) => res.json())
      .then((data) => {
        setDepartments(data.departments ?? []);
        setCategories(data.categories ?? []);
        setStockLocations(data.stockLocations ?? []);
        setVendors(data.vendors ?? []);
        setBuys(data.buys ?? []);
      })
      .catch(() => toast.error("Failed to load departments, vendors, and stock locations"));
  }, []);

  const supplierEntry = vendors.find((v) => sameSupplier(v.name, supplier));
  // Holt has no Vendor.partNumberPrefix (that's an Ordorite-export-only
  // concept from FC) — Vendor.code is the closest holt analog, and falls
  // back to an unprefixed part number when the vendor has no code set.
  const activePrefix = supplierEntry?.code ?? "";
  const markupValue = Number.parseFloat(defaults.markup);

  function reset() {
    setDraft(null);
    setResult(null);
    setSplits({});
    setRowDepts({});
    setRowCats({});
    setSellings({});
    setMsrps({});
    setNames({});
    setDescriptions({});
    setBarcodes({});
    setPoExcluded({});
    setPartNumbers({});
    setPoNumbers({});
  }

  async function parseFile(f: File) {
    setLoading(true);
    const formData = new FormData();
    formData.append("file", f);
    try {
      const res = await fetch(
        `/api/tools/home-accessory-order/preview?format=${encodeURIComponent(format)}`,
        { method: "POST", body: formData },
      );
      if (!res.ok) {
        throw new Error(await readServerError(res, "Parse failed"));
      }
      const next = (await res.json()) as HomeAccessoryDraft;
      reset();
      setDraft(next);
      setSupplier(next.vendorName);
      if (next.warnings?.length) {
        toast.warn(`${next.warnings.length} note(s) need a look — see above the table.`);
      }
      const record = vendors.find((v) => sameSupplier(v.name, next.vendorName));
      if (!record) {
        toast.warn(
          `No vendor named "${next.vendorName.trim()}" found, so part numbers cannot be ` +
            "prefixed. Fix the Supplier box to match an existing vendor, or add it under " +
            "Admin > Setup > Vendors.",
        );
      } else if (!record.code) {
        toast.warn(`"${record.name}" has no vendor code set, so part numbers export unprefixed.`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to parse the file");
    } finally {
      setLoading(false);
    }
  }

  /** Split a set line into its pieces — an even/preset split the buyer then
   *  adjusts (holt has no catalog-adopt path; see file header). */
  function splitRow(rowIndex: number, parts: number) {
    const row = draft?.rows[rowIndex];
    if (!row) return;
    setSplits((prev) => ({
      ...prev,
      [rowIndex]: partsFromPercents(row.cost, defaultSuffixes(parts), defaultSplitPercents(parts)),
    }));
  }

  function applyPreset(rowIndex: number, percents: number[]) {
    const row = draft?.rows[rowIndex];
    const parts = splits[rowIndex];
    if (!row || !parts) return;
    setSplits((prev) => ({
      ...prev,
      [rowIndex]: partsFromPercents(
        row.cost,
        parts.map((p) => p.suffix),
        percents,
      ),
    }));
  }

  function editSplitPercent(rowIndex: number, partIndex: number, percentRaw: string) {
    const row = draft?.rows[rowIndex];
    if (!row) return;
    const percent = Number.parseFloat(percentRaw);
    if (!Number.isFinite(percent)) return;
    const cost = Math.round(row.cost * percent) / 100;
    editSplit(rowIndex, partIndex, { cost: String(cost) });
  }

  function unsplitRow(rowIndex: number) {
    setSplits((prev) => {
      const next = { ...prev };
      delete next[rowIndex];
      return next;
    });
  }

  function editSplit(rowIndex: number, partIndex: number, patch: Partial<SplitPart>) {
    setSplits((prev) => {
      const parts = prev[rowIndex];
      if (!parts) return prev;
      const next = parts.map((p, i) => (i === partIndex ? { ...p, ...patch } : p));
      return { ...prev, [rowIndex]: next };
    });
  }

  const rows: EffectiveRow[] = useMemo(
    () =>
      composeHomeAccessoryRows({
        draft,
        splits,
        edits: {
          rowDepts,
          rowCats,
          sellings,
          msrps,
          names,
          descriptions,
          barcodes,
          poExcluded,
          partNumbers,
        },
        departments,
        categories,
        defaultDepartmentId: defaults.departmentId,
        defaultCategoryId: defaults.categoryId,
        markup: markupValue,
        supplier: supplier.trim(),
        prefix: activePrefix,
        stockFamily: defaults.stockFamily.trim(),
        poNumbers,
      }),
    [
      draft,
      splits,
      rowDepts,
      rowCats,
      sellings,
      msrps,
      departments,
      categories,
      defaults.departmentId,
      defaults.categoryId,
      markupValue,
      supplier,
      activePrefix,
      names,
      descriptions,
      barcodes,
      poExcluded,
      partNumbers,
      defaults.stockFamily,
      poNumbers,
    ],
  );

  // Typing one PO across several orders is legitimate (one pre-set-up PO can
  // cover a whole bundle) but it MERGES them into a single draft PO, which
  // is a surprise if it wasn't meant — a draft PO groups by its Reference.
  const mergedPoWarning = (() => {
    const refs = (draft?.orders ?? []).map(
      (o) => poNumbers[o.orderNumber]?.trim() || o.orderNumber,
    );
    const merged = refs.filter((r, i) => r && refs.indexOf(r) !== i);
    if (merged.length === 0) return "";
    return `${merged.length + 1} orders share a PO number — they will create ONE draft PO.`;
  })();

  const poRows = rows.filter((r) => !r.poExcluded);
  const poTotal = poReconciliationTotal(rows);
  const rowsComposedTotal = composedTotal(rows);
  const documentTotal = (draft?.rows ?? []).reduce((sum, r) => sum + r.qty * r.cost, 0);
  const totalsAgree = Math.abs(rowsComposedTotal - documentTotal) < 0.01;
  const excludedCount = rows.length - poRows.length;
  const unclassified = unclassifiedRowCount(rows);
  const acceptsCsv = HOME_ACCESSORY_FORMATS.find((f) => f.id === format)?.accepts === "csv";
  const uploadKind = acceptsCsv ? "CSV" : "PDF";
  const orderCount = draft?.orders.length ?? 0;

  async function commit() {
    if (!draft) return;
    setCommitting(true);
    try {
      const requiredDateByReference: Record<string, string> = {};
      for (const o of draft.orders) {
        const ref = poNumbers[o.orderNumber]?.trim() || o.orderNumber;
        if (o.requiredDate) requiredDateByReference[ref] = o.requiredDate;
      }
      const res = await fetch("/api/tools/home-accessory-order/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          supplier: supplier.trim(),
          vendorId: supplierEntry?.id ?? null,
          stockLocationId: defaults.stockLocationId,
          buyId: defaults.buyId,
          requiredDateByReference,
          rows,
        }),
      });
      if (!res.ok) {
        throw new Error(await readServerError(res, "Failed to create draft PO(s) and items"));
      }
      const data = (await res.json()) as CommitResult;
      setResult(data);
      toast.success(
        `Created ${data.poCount} draft PO(s) and ${data.itemCount} draft item(s).` +
          (data.unassignedCount > 0 ? ` ${data.unassignedCount} item(s) left unassigned.` : ""),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create draft PO(s) and items");
    } finally {
      setCommitting(false);
    }
  }

  const renderRow = (r: EffectiveRow, insideGroup: boolean) => (
    <HomeAccessoryRow
      key={r.key}
      row={r}
      insideGroup={insideGroup}
      departments={departments}
      categories={categories}
      splitParts={splits[r.rowIndex]}
      parentCost={draft?.rows[r.rowIndex]?.cost ?? 0}
      onSplit={splitRow}
      onUnsplit={unsplitRow}
      onEditSplit={editSplit}
      onEditPercent={editSplitPercent}
      onApplyPreset={applyPreset}
      onPickDept={(id) => {
        setRowDepts((p) => ({ ...p, [r.key]: id }));
        setRowCats((p) => {
          const next = { ...p };
          delete next[r.key];
          return next;
        });
      }}
      onPickCat={(id) => setRowCats((p) => ({ ...p, [r.key]: id }))}
      onEditMsrp={(v) => setMsrps((p) => ({ ...p, [r.key]: v }))}
      onEditSelling={(v) => setSellings((p) => ({ ...p, [r.key]: v }))}
      onEditName={(v) => setNames((p) => ({ ...p, [r.key]: v }))}
      onEditDescription={(v) => setDescriptions((p) => ({ ...p, [r.key]: v }))}
      onEditBarcode={(v) => setBarcodes((p) => ({ ...p, [r.key]: v }))}
      onTogglePo={(on) => setPoExcluded((p) => ({ ...p, [r.key]: !on }))}
      onEditPartNumber={(v) => setPartNumbers((p) => ({ ...p, [r.key]: v }))}
      formatCurrency={fmt}
    />
  );

  return (
    <div className="py-2 space-y-6 font-serif">
      <h1 className="text-2xl text-sh-blue font-semibold">Home Accessory Order Import</h1>

      {!draft && (
        <>
          <p className="text-sm text-sh-gray">
            Parse a home accessory vendor order, classify each item, split sets into their pieces,
            and create draft purchase orders + items in Buyer Drafts. Nothing is written until you
            press &quot;Create draft PO(s) + items&quot; at the bottom of the preview.
          </p>
          <div className="flex flex-wrap items-end gap-4 rounded-lg border border-sh-gray/20 bg-white p-5">
            <div>
              <label htmlFor="ha-format" className="mb-1 block text-xs text-sh-gray">
                Vendor format
              </label>
              <select
                id="ha-format"
                value={format}
                onChange={(e) => setFormat(e.target.value as HomeAccessoryFormatId)}
                className="w-72 rounded border border-gray-300 px-3 py-2 text-sm focus:border-sh-gold focus:outline-none"
              >
                {HOME_ACCESSORY_FORMATS.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
              <p className="mt-1 max-w-md text-xs text-sh-gray">
                {HOME_ACCESSORY_FORMATS.find((f) => f.id === format)?.notes}
              </p>
            </div>
            <div>
              <label
                htmlFor="ha-file"
                className="inline-flex min-h-[44px] cursor-pointer items-center gap-2 rounded bg-sh-blue px-4 py-2 text-sm font-semibold text-white hover:bg-sh-navy"
              >
                <Upload className="h-4 w-4" />
                {loading ? "Parsing…" : `Upload ${uploadKind}`}
              </label>
              <input
                id="ha-file"
                type="file"
                accept={acceptsCsv ? ".csv" : ".pdf"}
                disabled={loading}
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void parseFile(f);
                  e.target.value = "";
                }}
              />
            </div>
          </div>
        </>
      )}

      {result && (
        <div className="rounded border border-green-200 bg-green-50 p-4 text-sm text-green-900">
          <p className="font-semibold">
            Created {result.poCount} draft PO{result.poCount === 1 ? "" : "s"} and{" "}
            {result.itemCount} draft item{result.itemCount === 1 ? "" : "s"}
            {result.unassignedCount > 0 ? ` (${result.unassignedCount} unassigned)` : ""}.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <Button onClick={() => router.push("/app/admin/buyer-drafts")}>
              View in Buyer Drafts
            </Button>
            <Button variant="outline" onClick={reset}>
              <RotateCcw className="mr-1 h-4 w-4" />
              Start another order
            </Button>
          </div>
        </div>
      )}

      {draft && !result && (
        <>
          <div className="rounded-lg border border-sh-gray/20 bg-white p-5">
            <div className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
              <div>
                <span className="mb-1 block text-xs text-sh-gray">Vendor (document)</span>
                <p className="text-sh-black">{draft.vendorName}</p>
              </div>
              <div>
                <span className="mb-1 block text-xs text-sh-gray">Order date</span>
                <p className="text-sh-black">{draft.orderDate || "--"}</p>
              </div>
              <div>
                <span className="mb-1 block text-xs text-sh-gray">Orders</span>
                <p className="text-sh-black">{orderCount}</p>
              </div>
              <div>
                <span className="mb-1 block text-xs text-sh-gray">Lines parsed</span>
                <p className="text-sh-black">{draft.rows.length}</p>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-3">
              <div>
                <label htmlFor="ha-supplier" className="mb-1 block text-xs text-sh-gray">
                  Supplier
                </label>
                <input
                  id="ha-supplier"
                  type="text"
                  value={supplier}
                  onChange={(e) => setSupplier(e.target.value)}
                  className="min-h-[44px] w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-sh-gold focus:outline-none"
                />
                {!supplierEntry && (
                  <p className="mt-1 text-xs text-amber-700">
                    No vendor named &quot;{supplier.trim()}&quot; found — part numbers export
                    unprefixed and no vendor link is set on the created rows.
                  </p>
                )}
              </div>
              <div>
                <label htmlFor="ha-markup" className="mb-1 block text-xs text-sh-gray">
                  Markup (optional — e.g. 2.5 for 2.5x cost)
                </label>
                <input
                  id="ha-markup"
                  type="text"
                  inputMode="decimal"
                  placeholder="None"
                  value={defaults.markup}
                  onChange={(e) => setDefaults({ ...defaults, markup: e.target.value })}
                  title="Fills Selling + MSRP for rows without their own typed price. Rounds up to a price ending in 5 or 9."
                  className="min-h-[44px] w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-sh-gold focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="ha-stock-family" className="mb-1 block text-xs text-sh-gray">
                  Stock family (optional)
                </label>
                <input
                  id="ha-stock-family"
                  type="text"
                  value={defaults.stockFamily}
                  onChange={(e) => setDefaults({ ...defaults, stockFamily: e.target.value })}
                  className="min-h-[44px] w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-sh-gold focus:outline-none"
                />
              </div>
              <div>
                <span className="mb-1 block text-xs text-sh-gray">
                  {orderCount > 1
                    ? "PO numbers (optional) — one per order"
                    : "PO number (optional)"}
                </span>
                <div className="space-y-2">
                  {draft.orders.map((o) => (
                    <div key={o.orderNumber} className="flex items-center gap-2">
                      {orderCount > 1 && (
                        <label
                          htmlFor={`ha-po-${o.orderNumber}`}
                          className="w-28 shrink-0 truncate text-xs text-sh-gray"
                          title={`Order ${o.orderNumber} — ${o.itemCount} item(s)`}
                        >
                          {o.orderNumber}
                        </label>
                      )}
                      <input
                        id={`ha-po-${o.orderNumber}`}
                        type="text"
                        placeholder={o.orderNumber}
                        value={poNumbers[o.orderNumber] ?? ""}
                        onChange={(e) =>
                          setPoNumbers({ ...poNumbers, [o.orderNumber]: e.target.value })
                        }
                        title="Leave blank to use the vendor's own order number as the draft PO's reference. Type a number to land this order's lines on a different reference instead."
                        className="min-h-[44px] w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-sh-gold focus:outline-none"
                      />
                    </div>
                  ))}
                </div>
                {mergedPoWarning && (
                  <p className="mt-1 text-xs text-amber-700">{mergedPoWarning}</p>
                )}
              </div>
              <div>
                <label htmlFor="ha-location" className="mb-1 block text-xs text-sh-gray">
                  Stock location (where items will land)
                </label>
                <select
                  id="ha-location"
                  value={defaults.stockLocationId ?? ""}
                  onChange={(e) =>
                    setDefaults({
                      ...defaults,
                      stockLocationId: Number.parseInt(e.target.value) || null,
                    })
                  }
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-sh-gold focus:outline-none"
                >
                  <option value="">None — set it later</option>
                  {stockLocations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.code} — {l.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="ha-buy" className="mb-1 block text-xs text-sh-gray">
                  Buy (optional)
                </label>
                <select
                  id="ha-buy"
                  value={defaults.buyId ?? ""}
                  onChange={(e) =>
                    setDefaults({ ...defaults, buyId: Number.parseInt(e.target.value) || null })
                  }
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-sh-gold focus:outline-none"
                >
                  <option value="">Unassigned</option>
                  {buys.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name} {b.season ? `(${b.season}${b.year ? " " + b.year : ""})` : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="ha-def-dept" className="mb-1 block text-xs text-sh-gray">
                  Default department (rows without a pick)
                </label>
                <select
                  id="ha-def-dept"
                  value={defaults.departmentId ?? ""}
                  onChange={(e) =>
                    setDefaults({
                      ...defaults,
                      departmentId: Number.parseInt(e.target.value) || null,
                      categoryId: null,
                    })
                  }
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-sh-gold focus:outline-none"
                >
                  <option value="">None</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="ha-def-cat" className="mb-1 block text-xs text-sh-gray">
                  Default category
                </label>
                <select
                  id="ha-def-cat"
                  value={defaults.categoryId ?? ""}
                  onChange={(e) =>
                    setDefaults({
                      ...defaults,
                      categoryId: Number.parseInt(e.target.value) || null,
                    })
                  }
                  disabled={!defaults.departmentId}
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-sh-gold focus:outline-none"
                >
                  <option value="">
                    {defaults.departmentId ? "None" : "Pick a department first"}
                  </option>
                  {categories
                    .filter((c) => c.departmentId === defaults.departmentId)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </select>
              </div>
            </div>
          </div>

          {draft.warnings && draft.warnings.length > 0 && (
            <div className="rounded border border-amber-200 bg-amber-50 p-4">
              <h4 className="mb-1 text-sm font-semibold text-amber-800">
                Check these against the order before creating drafts
              </h4>
              <ul className="list-inside list-disc space-y-0.5 text-sm text-amber-700">
                {draft.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {/* One card per item, not a wide table row — nothing forces a
              horizontal scroll, and the name/description get full width. */}
          <div className="flex flex-col gap-2.5">
            {groupRowsForRender(rows).map((block) =>
              block.kind === "single" ? (
                renderRow(block.row, false)
              ) : (
                <SplitGroupCard
                  key={`group-${block.rowIndex}`}
                  block={block}
                  setName={draft.rows[block.rowIndex]?.productName ?? ""}
                  setCost={draft.rows[block.rowIndex]?.cost ?? 0}
                  renderRow={renderRow}
                  formatCurrency={fmt}
                />
              ),
            )}
          </div>

          <div
            className={
              totalsAgree
                ? "rounded border border-gray-200 bg-sh-linen p-3 text-sm text-sh-gray"
                : "rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800"
            }
          >
            PO total {fmt(poTotal)}{" "}
            {totalsAgree
              ? "— matches the order documents."
              : `does NOT match the documents' ${fmt(documentTotal)}. A split's costs must add up to its set's cost.`}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={commit}
              disabled={committing || poRows.length === 0 || !totalsAgree || unclassified > 0}
              title={
                unclassified > 0
                  ? `${unclassified} row(s) still need a department and category`
                  : totalsAgree
                    ? undefined
                    : "A split's pieces must add up to the set cost first"
              }
            >
              <PackagePlus className="mr-1 h-4 w-4" />
              {committing
                ? "Creating…"
                : `Create draft PO(s) + items (${orderCount === 1 ? "1 order" : `${orderCount} orders`}, ${rows.length} item${rows.length === 1 ? "" : "s"}${excludedCount > 0 ? `, ${excludedCount} off PO` : ""})`}
            </Button>
            <Button variant="outline" onClick={reset}>
              <RotateCcw className="mr-1 h-4 w-4" />
              Start over
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/** The split / undo actions on a line. Holt has no catalog to "adopt" an
 *  existing split from (see file header) — a set is only ever offered a
 *  fresh even/preset split. */
function SplitControls({
  row,
  firstOfSplit,
  splitCount,
  onSplit,
  onUnsplit,
  onApplyPreset,
}: Readonly<{
  row: EffectiveRow;
  firstOfSplit: boolean;
  splitCount: number;
  onSplit: (rowIndex: number, parts: number) => void;
  onUnsplit: (rowIndex: number) => void;
  onApplyPreset: (rowIndex: number, percents: number[]) => void;
}>) {
  if (firstOfSplit) {
    const presets = SPLIT_PRESETS[splitCount] ?? [];
    return (
      <div className="mt-1 space-y-1">
        {presets.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 text-xs">
            <span className="text-sh-gray">Shape:</span>
            {presets.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => onApplyPreset(row.rowIndex, [...p.percents])}
                className="rounded border border-gray-300 px-1.5 py-0.5 text-xs text-sh-gray hover:border-sh-gold hover:text-sh-navy"
              >
                {p.label}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={() => onUnsplit(row.rowIndex)}
          className="flex items-center gap-1 text-xs text-sh-gray underline"
        >
          <Undo2 className="h-3 w-3" />
          Undo split
        </button>
      </div>
    );
  }
  if (row.isSplitChild || row.setSize === null) return null;
  return (
    <button
      type="button"
      onClick={() => onSplit(row.rowIndex, row.setSize ?? 2)}
      title={`The description says a set of ${row.setSize}. Split it into ${row.setSize} items, sharing the set's cost.`}
      className="mt-1 flex items-center gap-1 text-xs text-sh-gold underline"
    >
      <Scissors className="h-3 w-3" />
      Split into {row.setSize}
    </button>
  );
}

/** The row's Category picker.
 *
 *  Its own component because of the out-of-department case: a category
 *  name can repeat across departments, so a category prefilled from
 *  elsewhere may not be in this row's department-filtered list. Without an
 *  option for it the select would render BLANK and hide what is actually
 *  set. */
function CategoryCell({
  row,
  deptId,
  catId,
  categories,
  departments,
  onPickCat,
}: Readonly<{
  row: EffectiveRow;
  deptId: number | "";
  catId: number | "";
  categories: readonly CatOption[];
  departments: readonly DeptOption[];
  onPickCat: (id: number) => void;
}>) {
  const outsideDeptCat =
    row.categoryId == null
      ? undefined
      : categories.find((c) => c.id === row.categoryId && c.departmentId !== deptId);
  const outsideDeptName = outsideDeptCat
    ? (departments.find((d) => d.id === outsideDeptCat.departmentId)?.name ?? "other dept")
    : "";

  return (
    <select
      aria-label="Category"
      value={catId}
      onChange={(e) => onPickCat(Number.parseInt(e.target.value))}
      disabled={!row.department}
      className="w-full rounded border border-gray-300 px-1 py-1 text-xs focus:border-sh-gold focus:outline-none"
    >
      <option value="">--</option>
      {outsideDeptCat && (
        <option value={outsideDeptCat.id}>
          {outsideDeptCat.name} ({outsideDeptName})
        </option>
      )}
      {categories
        .filter((c) => c.departmentId === deptId)
        .map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
    </select>
  );
}

/** The row's Part No cell: the editable part number, plus (for a split
 *  piece) the "piece N of M" chip and the size-marker input. */
function PartNumberCell({
  row,
  partIndex,
  splitParts,
  onEditPartNumber,
  onEditSplit,
}: Readonly<{
  row: EffectiveRow;
  partIndex: number;
  splitParts: SplitPart[] | undefined;
  onEditPartNumber: (value: string) => void;
  onEditSplit: (rowIndex: number, partIndex: number, patch: Partial<SplitPart>) => void;
}>) {
  return (
    <>
      <input
        type="text"
        aria-label="Part number"
        value={row.partNumber}
        onChange={(e) => onEditPartNumber(e.target.value)}
        title="Clear it to go back to the composed default (vendor code + item number)."
        className="min-h-[44px] w-44 rounded border border-gray-300 px-2 py-1 font-mono text-xs focus:border-sh-gold focus:outline-none"
      />
      {row.isSplitChild && splitParts && (
        <>
          <span className="ml-1 whitespace-nowrap rounded bg-sh-gold/15 px-1 py-0.5 text-[10px] text-sh-gray">
            piece {partIndex + 1} of {splitParts.length}
          </span>
          <input
            type="text"
            aria-label="Size marker"
            value={splitParts[partIndex]?.suffix ?? ""}
            onChange={(e) => onEditSplit(row.rowIndex, partIndex, { suffix: e.target.value })}
            className="ml-1 w-14 rounded border border-gray-300 px-1 py-0.5 text-xs focus:border-sh-gold focus:outline-none"
          />
        </>
      )}
    </>
  );
}

function splitRowState(
  row: EffectiveRow,
  splitParts: SplitPart[] | undefined,
  parentCost: number,
): { partIndex: number; splitSum: number; splitOff: boolean; firstOfSplit: boolean } {
  const partIndex = row.isSplitChild ? Number.parseInt(row.key.split(":")[1]) : -1;
  const splitSum = (splitParts ?? []).reduce((sum, p) => sum + (Number.parseFloat(p.cost) || 0), 0);
  const splitOff = splitParts ? Math.abs(splitSum - parentCost) >= 0.01 : false;
  return { partIndex, splitSum, splitOff, firstOfSplit: row.isSplitChild && partIndex === 0 };
}

function FieldLabel({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-sh-gray">
      {children}
    </span>
  );
}

/**
 * The visual grouping for a split set. With several sets split
 * back-to-back, the pieces are hard to tell apart as separate sets — a run
 * of identical accented cards. So each set's pieces sit inside ONE
 * bordered, headed container, and consecutive groups alternate their
 * accent colour so two groups in a row never blur together.
 */
const GROUP_ACCENTS = [
  { border: "border-sh-gold/60", bg: "bg-sh-gold/5", text: "text-sh-gold" },
  { border: "border-sh-blue/60", bg: "bg-sh-blue/10", text: "text-sh-blue" },
] as const;

function SplitGroupCard({
  block,
  setName,
  setCost,
  renderRow,
  formatCurrency,
}: Readonly<{
  block: Extract<RenderBlock, { kind: "splitGroup" }>;
  setName: string;
  setCost: number;
  renderRow: (row: EffectiveRow, insideGroup: boolean) => ReactNode;
  formatCurrency: (n: number) => string;
}>) {
  const accent = GROUP_ACCENTS[block.groupOrdinal % GROUP_ACCENTS.length];
  const piecesSum = block.rows.reduce((sum, r) => sum + r.cost, 0);
  const off = piecesSum - setCost;
  const reconciled = Math.abs(off) < 0.01;
  return (
    <div className={`rounded-xl border-2 ${accent.border} ${accent.bg} p-2 sm:p-2.5`}>
      <div className="mb-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 px-1">
        <span className={`flex items-center gap-1.5 text-sm font-semibold ${accent.text}`}>
          <Scissors className="h-4 w-4" />
          Split set
        </span>
        <span className="text-sm text-sh-black">{setName}</span>
        <span className="rounded-full bg-white/80 px-2 py-0.5 text-[11px] font-medium text-sh-gray">
          {block.rows.length} pieces
        </span>
        <span className="rounded-full bg-white/80 px-2 py-0.5 text-[11px] text-sh-gray">
          set cost {formatCurrency(setCost)}
        </span>
        {reconciled ? (
          <span className="rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-medium text-green-800">
            pieces add up
          </span>
        ) : (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
            pieces {formatCurrency(piecesSum)} — {off > 0 ? "over" : "under"} by{" "}
            {formatCurrency(Math.abs(off))}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-2">{block.rows.map((r) => renderRow(r, true))}</div>
    </div>
  );
}

function HomeAccessoryRow({
  row,
  insideGroup,
  departments,
  categories,
  splitParts,
  parentCost,
  onSplit,
  onUnsplit,
  onEditSplit,
  onEditPercent,
  onApplyPreset,
  onPickDept,
  onPickCat,
  onEditMsrp,
  onEditSelling,
  onEditName,
  onEditDescription,
  onEditBarcode,
  onTogglePo,
  onEditPartNumber,
  formatCurrency,
}: Readonly<{
  row: EffectiveRow;
  insideGroup: boolean;
  departments: readonly DeptOption[];
  categories: readonly CatOption[];
  splitParts: SplitPart[] | undefined;
  parentCost: number;
  onSplit: (rowIndex: number, parts: number) => void;
  onUnsplit: (rowIndex: number) => void;
  onEditSplit: (rowIndex: number, partIndex: number, patch: Partial<SplitPart>) => void;
  onEditPercent: (rowIndex: number, partIndex: number, percentRaw: string) => void;
  onApplyPreset: (rowIndex: number, percents: number[]) => void;
  onPickDept: (id: number) => void;
  onPickCat: (id: number) => void;
  onEditMsrp: (v: string) => void;
  onEditSelling: (v: string) => void;
  onEditName: (v: string) => void;
  onEditDescription: (v: string) => void;
  onEditBarcode: (v: string) => void;
  onTogglePo: (on: boolean) => void;
  onEditPartNumber: (v: string) => void;
  formatCurrency: (n: number) => string;
}>) {
  const { partIndex, splitOff, firstOfSplit } = splitRowState(row, splitParts, parentCost);
  const deptId = row.departmentId ?? "";
  const catId = row.categoryId ?? "";
  const on = !row.poExcluded;

  return (
    <div
      className={
        insideGroup
          ? "rounded-lg border border-white bg-white/70 p-2.5"
          : `rounded-lg border p-2.5 ${on ? "border-gray-200 bg-white" : "border-gray-200 bg-gray-50 opacity-70"}`
      }
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-[220px] flex-1">
          <FieldLabel>Item</FieldLabel>
          <input
            type="text"
            aria-label="Item name"
            value={row.productName}
            onChange={(e) => onEditName(e.target.value)}
            className="mb-1 w-full rounded border border-gray-300 px-2 py-1 text-sm font-semibold focus:border-sh-gold focus:outline-none"
          />
          <textarea
            aria-label="Description"
            value={row.description ?? ""}
            onChange={(e) => onEditDescription(e.target.value)}
            placeholder="Description (optional)"
            rows={2}
            className="w-full resize-none rounded border border-gray-300 px-2 py-1 text-xs text-sh-gray focus:border-sh-gold focus:outline-none"
          />
          <SplitControls
            row={row}
            firstOfSplit={firstOfSplit}
            splitCount={splitParts?.length ?? row.setSize ?? 2}
            onSplit={onSplit}
            onUnsplit={onUnsplit}
            onApplyPreset={onApplyPreset}
          />
        </div>

        <div>
          <FieldLabel>Part #</FieldLabel>
          <div className="flex items-center">
            <PartNumberCell
              row={row}
              partIndex={partIndex}
              splitParts={splitParts}
              onEditPartNumber={onEditPartNumber}
              onEditSplit={onEditSplit}
            />
          </div>
        </div>

        <div className="w-16">
          <FieldLabel>Qty</FieldLabel>
          <p className="pt-1.5 text-sm">{row.qty}</p>
        </div>

        <div className="w-28">
          <FieldLabel>{row.isSplitChild ? "Piece cost" : "Cost"}</FieldLabel>
          {row.isSplitChild && splitParts ? (
            <>
              <input
                type="text"
                inputMode="decimal"
                aria-label="Piece cost"
                value={splitParts[partIndex]?.cost ?? ""}
                onChange={(e) => onEditSplit(row.rowIndex, partIndex, { cost: e.target.value })}
                className="w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-sh-gold focus:outline-none"
              />
              <input
                type="text"
                inputMode="decimal"
                aria-label="Piece percent"
                placeholder="%"
                onChange={(e) => onEditPercent(row.rowIndex, partIndex, e.target.value)}
                className="mt-1 w-full rounded border border-gray-300 px-2 py-0.5 text-xs text-sh-gray focus:border-sh-gold focus:outline-none"
              />
              {splitOff && firstOfSplit && (
                <p className="mt-0.5 text-[11px] text-amber-700">pieces don&apos;t add up yet</p>
              )}
            </>
          ) : (
            <p className="pt-1.5 text-sm">{formatCurrency(row.cost)}</p>
          )}
        </div>

        <div className="w-28">
          <FieldLabel>Selling</FieldLabel>
          <input
            type="text"
            inputMode="decimal"
            aria-label="Selling price"
            value={row.selling ?? ""}
            onChange={(e) => onEditSelling(e.target.value)}
            placeholder="--"
            className="w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-sh-gold focus:outline-none"
          />
        </div>

        <div className="w-28">
          <FieldLabel>MSRP</FieldLabel>
          <input
            type="text"
            inputMode="decimal"
            aria-label="MSRP"
            value={row.msrp ?? ""}
            onChange={(e) => onEditMsrp(e.target.value)}
            placeholder="--"
            className="w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-sh-gold focus:outline-none"
          />
        </div>

        <div className="w-36">
          <FieldLabel>Barcode</FieldLabel>
          <input
            type="text"
            aria-label="Barcode"
            value={row.barcode}
            onChange={(e) => onEditBarcode(e.target.value)}
            placeholder="none"
            className="w-full rounded border border-gray-300 px-2 py-1 font-mono text-xs focus:border-sh-gold focus:outline-none"
          />
        </div>

        <div className="w-36">
          <FieldLabel>Department</FieldLabel>
          <select
            aria-label="Department"
            value={deptId}
            onChange={(e) => onPickDept(Number.parseInt(e.target.value))}
            className="w-full rounded border border-gray-300 px-1 py-1 text-xs focus:border-sh-gold focus:outline-none"
          >
            <option value="">--</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>

        <div className="w-36">
          <FieldLabel>Category</FieldLabel>
          <CategoryCell
            row={row}
            deptId={deptId}
            catId={catId}
            categories={categories}
            departments={departments}
            onPickCat={onPickCat}
          />
        </div>

        <div className="w-24">
          <FieldLabel>On PO</FieldLabel>
          <label className="mt-1.5 flex min-h-[44px] items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              checked={on}
              onChange={(e) => onTogglePo(e.target.checked)}
              title="Uncheck to create this item without assigning it to a draft PO (already on a PO elsewhere)."
            />
            {on ? "Yes" : "No"}
          </label>
        </div>
      </div>
    </div>
  );
}
