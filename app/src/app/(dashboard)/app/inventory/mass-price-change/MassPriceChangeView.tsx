"use client";

// /app/src/app/(dashboard)/app/inventory/mass-price-change/MassPriceChangeView.tsx
//
// Mass price change (GAP-06, DECISIONS 58). Filter the catalog, choose rows
// (a selection kept across pages, like Categorize Products) or everything the
// filter matches, say what to do to retail and the was price, preview, apply.
//
// The server does the pricing: preview works out each product's new price and
// says why any is left out; apply sends the previewed rows back, and the server
// refuses any whose price moved since (stale) and keeps locked ones. A preview
// belongs to the selection and change it was made for -- change either and it
// is hidden until previewed again. There is no undo: a reversal is another
// mass change. Lock and unlock act on the selection directly.

import { useCallback, useEffect, useMemo, useState } from "react";
import axios from "axios";
import Link from "next/link";
import { toast } from "react-toastify";
import { Lock, LockOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { getErrorMessage } from "@/lib/toastError";
import {
  RETAIL_ROUNDINGS,
  RETAIL_ROUNDING_LABELS,
  isRetailRounding,
  type RetailRounding,
} from "@/lib/pricing/rounding";
import {
  MASS_CHANGE_MAX_PRODUCTS,
  MASS_CHANGE_NOTE_MAX,
  MASS_CHANGE_SKIPS,
  type MassChangeApplyResult,
  type MassChangeFilter,
  type MassChangeOperation,
  type MassChangePreviewRow,
  type MassChangeSelection,
  type MassChangeSkip,
  type RetailOperation,
  type WasOperation,
} from "@/lib/pricing/massChangeShared";

const PAGE_SIZE = 50;

interface Named {
  id: number;
  name: string;
}

interface Options {
  vendors: Named[];
  departments: Named[];
  categories: (Named & { departmentId: number })[];
}

interface ListRow {
  id: number;
  productNumber: string;
  name: string;
  vendor: Named | null;
  department: Named | null;
  category: Named | null;
  baseCost?: number | null;
  baseRetail: number | null;
  wasPrice: number | null;
  priceLocked: boolean;
}

interface ListResponse {
  total: number;
  page: number;
  pageSize: number;
  costVisible: boolean;
  rows: ListRow[];
}

interface PreviewResponse {
  rows: MassChangePreviewRow[];
  toChange: number;
  skipped: Partial<Record<MassChangeSkip, number>>;
  rounding: RetailRounding;
}

type RetailKind = RetailOperation["kind"];

const RETAIL_KINDS: { kind: RetailKind; label: string }[] = [
  { kind: "FROM_MARKUP", label: "Cost × markup (vendor, category or store)" },
  { kind: "PERCENT", label: "Up or down by a percent" },
  { kind: "AMOUNT", label: "Set to an amount" },
  { kind: "KEEP", label: "Leave retail as it is" },
];

const WAS_CHOICES: { value: WasOperation; label: string }[] = [
  { value: "KEEP", label: "Leave the was price as it is" },
  { value: "FROM_CURRENT", label: "Today's retail becomes the was price (a markdown)" },
  { value: "CLEAR", label: "Clear the was price" },
];

const LOCKED_CHOICES = [
  { value: "", label: "Locked or not" },
  { value: "unlocked", label: "Not locked" },
  { value: "locked", label: "Locked" },
] as const;

const fieldCls =
  "w-full border border-brand-gray/30 rounded-lg px-3 py-2 text-sm text-brand-black min-h-[40px] bg-white focus:outline-none focus:ring-1 focus:ring-brand-blue";
const labelCls = "block text-xs font-semibold text-brand-gray uppercase tracking-wide mb-1";

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

const idOrUndefined = (value: string) => (value ? Number(value) : undefined);

function sameCents(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.round(a * 100) === Math.round(b * 100);
}

function PriceMove({
  from,
  to,
  fmt,
}: Readonly<{
  from: number | null;
  to: number | null;
  fmt: (value: number | null | undefined) => string;
}>) {
  const show = (v: number | null) => (v === null ? "none" : fmt(v));
  if (sameCents(from, to)) return <span className="tabular-nums">{show(from)}</span>;
  return (
    <span className="tabular-nums">
      <span className="text-brand-gray">{show(from)}</span> → <strong>{show(to)}</strong>
    </span>
  );
}

function FilterBar({
  options,
  filter,
  onFilter,
}: Readonly<{
  options: Options | null;
  filter: MassChangeFilter;
  onFilter: (next: MassChangeFilter) => void;
}>) {
  const [searchInput, setSearchInput] = useState(filter.q ?? "");
  const categories = useMemo(
    () =>
      (options?.categories ?? []).filter(
        (c) => !filter.departmentId || c.departmentId === filter.departmentId,
      ),
    [options, filter.departmentId],
  );
  return (
    <div className="bg-white border border-brand-gray/20 rounded-lg p-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div>
          <label htmlFor="mpc-vendor" className={labelCls}>
            Vendor
          </label>
          <select
            id="mpc-vendor"
            value={filter.vendorId ?? ""}
            onChange={(e) => onFilter({ ...filter, vendorId: idOrUndefined(e.target.value) })}
            className={fieldCls}
          >
            <option value="">Any vendor</option>
            {options?.vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="mpc-department" className={labelCls}>
            Department
          </label>
          <select
            id="mpc-department"
            value={filter.departmentId ?? ""}
            onChange={(e) =>
              onFilter({
                ...filter,
                departmentId: idOrUndefined(e.target.value),
                categoryId: undefined,
              })
            }
            className={fieldCls}
          >
            <option value="">Any department</option>
            {options?.departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="mpc-category" className={labelCls}>
            Category
          </label>
          <select
            id="mpc-category"
            value={filter.categoryId ?? ""}
            onChange={(e) => onFilter({ ...filter, categoryId: idOrUndefined(e.target.value) })}
            className={fieldCls}
          >
            <option value="">Any category</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="mpc-locked" className={labelCls}>
            Price lock
          </label>
          <select
            id="mpc-locked"
            value={filter.locked ?? ""}
            onChange={(e) =>
              onFilter({
                ...filter,
                locked:
                  e.target.value === "" ? undefined : (e.target.value as "locked" | "unlocked"),
              })
            }
            className={fieldCls}
          >
            {LOCKED_CHOICES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="mpc-search" className={labelCls}>
            Name or part #
          </label>
          <div className="flex gap-2">
            <input
              id="mpc-search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onFilter({ ...filter, q: searchInput.trim() || undefined });
              }}
              placeholder="e.g. sofa, 1234"
              className={fieldCls}
            />
            <Button
              onClick={() => onFilter({ ...filter, q: searchInput.trim() || undefined })}
              className="min-h-[40px] px-3"
            >
              Find
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProductTable({
  rows,
  loading,
  total,
  page,
  costVisible,
  selected,
  allMatching,
  onToggle,
  onToggleAllOnPage,
  onPage,
}: Readonly<{
  rows: ListRow[];
  loading: boolean;
  total: number;
  page: number;
  costVisible: boolean;
  selected: Set<number>;
  allMatching: boolean;
  onToggle: (id: number) => void;
  onToggleAllOnPage: () => void;
  onPage: (page: number) => void;
}>) {
  const fmt = useMoneyFormatter();
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const allOnPage = rows.length > 0 && rows.every((r) => allMatching || selected.has(r.id));
  const columns = costVisible ? 8 : 7;
  return (
    <div className="bg-white border border-brand-gray/20 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-brand-gray/20 bg-brand-linen">
        <p className="text-sm text-brand-gray">
          {loading ? "Loading…" : `${plural(total, "product")} — page ${page} of ${totalPages}`}
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => onPage(Math.max(1, page - 1))}
            disabled={page === 1}
            className="px-2 py-1 text-sm text-brand-blue disabled:text-brand-gray/50"
          >
            ← Prev
          </button>
          <button
            onClick={() => onPage(Math.min(totalPages, page + 1))}
            disabled={page >= totalPages}
            className="px-2 py-1 text-sm text-brand-blue disabled:text-brand-gray/50"
          >
            Next →
          </button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-brand-gray/20 text-left text-xs text-brand-gray uppercase tracking-wide">
              <th className="px-3 py-2 w-8">
                <input
                  type="checkbox"
                  aria-label="Select every product on this page"
                  checked={allOnPage}
                  disabled={allMatching}
                  onChange={onToggleAllOnPage}
                />
              </th>
              <th className="px-3 py-2">Part #</th>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Vendor</th>
              <th className="px-3 py-2">Category</th>
              {costVisible && <th className="px-3 py-2 text-right">Cost</th>}
              <th className="px-3 py-2 text-right">Retail</th>
              <th className="px-3 py-2 text-right">Was</th>
            </tr>
          </thead>
          <tbody>
            {!loading && rows.length === 0 ? (
              <tr>
                <td colSpan={columns} className="px-3 py-8 text-center text-brand-gray">
                  No products match.
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const isSelected = allMatching || selected.has(r.id);
                return (
                  <tr
                    key={r.id}
                    onClick={() => !allMatching && onToggle(r.id)}
                    className={`border-b border-brand-gray/10 transition ${
                      allMatching ? "" : "cursor-pointer"
                    } ${isSelected ? "bg-brand-linen" : "hover:bg-brand-stripe"}`}
                  >
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label={`Select ${r.name}`}
                        checked={isSelected}
                        disabled={allMatching}
                        onChange={() => onToggle(r.id)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-brand-gray">
                      {r.productNumber}
                    </td>
                    <td className="px-3 py-2 text-brand-black max-w-[280px]">
                      <Link
                        href={`/app/inventory/products/${r.id}`}
                        onClick={(e) => e.stopPropagation()}
                        className="hover:underline"
                      >
                        {r.name}
                      </Link>
                      {r.priceLocked && (
                        <span className="ml-2 inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900">
                          <Lock className="h-3 w-3" aria-hidden /> Locked
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">{r.vendor?.name ?? "—"}</td>
                    <td className="px-3 py-2 text-brand-gray">{r.category?.name ?? "—"}</td>
                    {costVisible && (
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.baseCost == null ? "—" : fmt(r.baseCost)}
                      </td>
                    )}
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.baseRetail == null ? "—" : fmt(r.baseRetail)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.wasPrice == null ? "—" : fmt(r.wasPrice)}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PreviewPanel({
  preview,
  applying,
  note,
  onNote,
  onApply,
}: Readonly<{
  preview: PreviewResponse;
  applying: boolean;
  note: string;
  onNote: (note: string) => void;
  onApply: () => void;
}>) {
  const fmt = useMoneyFormatter();
  const [showSkipped, setShowSkipped] = useState(false);
  const leftOut = preview.rows.length - preview.toChange;
  const shown = showSkipped ? preview.rows : preview.rows.filter((r) => !r.skipped);
  const skippedEntries = Object.entries(preview.skipped) as [MassChangeSkip, number][];
  return (
    <div className="bg-white border border-brand-blue/40 rounded-lg p-4 space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-brand-blue">Preview</h2>
        <p className="text-sm text-brand-black">
          {plural(preview.toChange, "product")} will change.
          {leftOut > 0 && ` ${plural(leftOut, "product")} left out.`} Worked-out prices are rounded{" "}
          {RETAIL_ROUNDING_LABELS[preview.rounding].toLowerCase()}; an amount you set is not.
        </p>
        {skippedEntries.length > 0 && (
          <ul className="mt-1 text-xs text-brand-gray list-disc pl-5">
            {skippedEntries.map(([reason, n]) => (
              <li key={reason}>
                {MASS_CHANGE_SKIPS[reason]}: {n.toLocaleString()}
              </li>
            ))}
          </ul>
        )}
      </div>

      {leftOut > 0 && (
        <label className="flex items-center gap-2 text-sm text-brand-black">
          <input
            type="checkbox"
            checked={showSkipped}
            onChange={(e) => setShowSkipped(e.target.checked)}
          />
          Show the ones left out
        </label>
      )}

      <div className="max-h-[420px] overflow-auto border border-brand-gray/20 rounded">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-white">
            <tr className="border-b border-brand-gray/20 text-left text-xs text-brand-gray uppercase tracking-wide">
              <th className="px-3 py-2">Part #</th>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2 text-right">Retail</th>
              <th className="px-3 py-2 text-right">Was</th>
              <th className="px-3 py-2">Left out because</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-brand-gray">
                  Nothing to change.
                </td>
              </tr>
            ) : (
              shown.map((r) => (
                <tr
                  key={r.productId}
                  className={`border-b border-brand-gray/10 ${r.skipped ? "text-brand-gray" : ""}`}
                >
                  <td className="px-3 py-2 font-mono text-xs">{r.productNumber}</td>
                  <td className="px-3 py-2">{r.name}</td>
                  <td className="px-3 py-2 text-right">
                    <PriceMove from={r.fromRetail} to={r.toRetail} fmt={fmt} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <PriceMove from={r.fromWas} to={r.toWas} fmt={fmt} />
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {r.skipped ? MASS_CHANGE_SKIPS[r.skipped] : ""}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[240px]">
          <label htmlFor="mpc-note" className={labelCls}>
            Note for the price history (optional)
          </label>
          <input
            id="mpc-note"
            value={note}
            maxLength={MASS_CHANGE_NOTE_MAX}
            onChange={(e) => onNote(e.target.value)}
            placeholder="e.g. Spring markdown"
            className={fieldCls}
          />
        </div>
        <Button
          onClick={onApply}
          disabled={applying || preview.toChange === 0}
          className="min-h-[40px] px-6"
        >
          {applying ? "Applying…" : `Apply to ${plural(preview.toChange, "product")}`}
        </Button>
      </div>
    </div>
  );
}

function ResultPanel({
  result,
  onDismiss,
}: Readonly<{ result: MassChangeApplyResult; onDismiss: () => void }>) {
  return (
    <div className="bg-green-50 border border-green-200 rounded-lg p-4 space-y-2 text-sm">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-lg font-semibold text-green-900">
          {plural(result.changed, "price")} changed
        </h2>
        <button onClick={onDismiss} className="text-sm text-brand-gray underline">
          Dismiss
        </button>
      </div>
      <ul className="list-disc pl-5 text-brand-black">
        {result.unchanged > 0 && <li>Already at that price: {result.unchanged}</li>}
        {result.skippedLocked > 0 && (
          <li>Locked since the preview, so kept: {result.skippedLocked}</li>
        )}
        {result.stale.length > 0 && (
          <li>
            Changed by someone else since the preview, so left alone: {result.stale.length}. Preview
            again to include them.
          </li>
        )}
        {result.missing.length > 0 && <li>No longer in the catalog: {result.missing.length}</li>}
      </ul>
      <p className="text-xs text-brand-gray">
        Each change is in its product&apos;s price history. There is no undo; to reverse it, run
        another mass change.
      </p>
    </div>
  );
}

export function MassPriceChangeView() {
  const [options, setOptions] = useState<Options | null>(null);
  const [filter, setFilter] = useState<MassChangeFilter>({});
  const [page, setPage] = useState(1);
  const [list, setList] = useState<ListResponse | null>(null);
  // The list answers for one filter, page and reload; loading until it has.
  const [reloadTick, setReloadTick] = useState(0);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const listKey = JSON.stringify({ filter, page, reloadTick });
  const loading = loadedKey !== listKey;
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [allMatching, setAllMatching] = useState(false);

  const [chosenKind, setRetailKind] = useState<RetailKind>("FROM_MARKUP");
  const [percent, setPercent] = useState("");
  const [amount, setAmount] = useState("");
  const [was, setWas] = useState<WasOperation>("KEEP");
  const [rounding, setRounding] = useState<RetailRounding | "">("");
  const [note, setNote] = useState("");

  const [preview, setPreview] = useState<(PreviewResponse & { key: string }) | null>(null);
  const [result, setResult] = useState<MassChangeApplyResult | null>(null);
  const [busy, setBusy] = useState<"preview" | "apply" | "lock" | null>(null);

  useEffect(() => {
    axios
      .get<Options>("/api/pricing/mass-change/options")
      .then((res) => setOptions(res.data))
      .catch((err) =>
        toast.error(getErrorMessage(err, "Couldn't load the vendors and categories.")),
      );
  }, []);

  useEffect(() => {
    let live = true;
    axios
      .get<ListResponse>("/api/pricing/mass-change", {
        params: { ...filter, page, pageSize: PAGE_SIZE },
      })
      .then((res) => {
        if (live) setList(res.data);
      })
      .catch((err) => {
        if (live) toast.error(getErrorMessage(err, "Couldn't load the products."));
      })
      .finally(() => {
        if (live) setLoadedKey(listKey);
      });
    return () => {
      live = false;
    };
  }, [filter, page, listKey]);

  const reloadList = () => setReloadTick((n) => n + 1);

  const total = list?.total ?? 0;
  // Cost × markup answers with cost, so it is offered only to someone who may
  // see cost (the preview refuses it otherwise, SEC-14).
  const costHidden = list?.costVisible === false;
  const retailKinds = costHidden
    ? RETAIL_KINDS.filter((k) => k.kind !== "FROM_MARKUP")
    : RETAIL_KINDS;
  const retailKind: RetailKind =
    costHidden && chosenKind === "FROM_MARKUP" ? "PERCENT" : chosenKind;
  const count = allMatching ? total : selected.size;

  const selection: MassChangeSelection = useMemo(
    () => (allMatching ? { filter } : { productIds: [...selected].sort((a, b) => a - b) }),
    [allMatching, filter, selected],
  );

  const operation: MassChangeOperation = useMemo(() => {
    let retail: RetailOperation;
    if (retailKind === "PERCENT") retail = { kind: "PERCENT", percent: Number(percent) };
    else if (retailKind === "AMOUNT") retail = { kind: "AMOUNT", amount: Number(amount) };
    else retail = { kind: retailKind };
    return { retail, was, ...(rounding && { rounding }) };
  }, [retailKind, percent, amount, was, rounding]);

  // A preview answers for one selection and one change; anything else hides it.
  const key = JSON.stringify({ selection, operation });
  const currentPreview = preview?.key === key ? preview : null;

  const changeFilter = (next: MassChangeFilter) => {
    setFilter(next);
    setPage(1);
  };

  const toggleRow = useCallback((id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAllOnPage = () => {
    const rows = list?.rows ?? [];
    setSelected((prev) => {
      const next = new Set(prev);
      const all = rows.every((r) => next.has(r.id));
      for (const r of rows) {
        if (all) next.delete(r.id);
        else next.add(r.id);
      }
      return next;
    });
  };

  const clearSelection = () => {
    setSelected(new Set());
    setAllMatching(false);
  };

  const runPreview = async () => {
    setBusy("preview");
    setResult(null);
    try {
      const res = await axios.post<PreviewResponse>("/api/pricing/mass-change/preview", {
        selection,
        operation,
      });
      setPreview({ ...res.data, key });
    } catch (err) {
      toast.error(getErrorMessage(err, "Couldn't work out the new prices."));
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    if (!currentPreview) return;
    const rows = currentPreview.rows
      .filter((r) => !r.skipped)
      .map(({ productId, fromRetail, toRetail, fromWas, toWas }) => ({
        productId,
        fromRetail,
        toRetail,
        fromWas,
        toWas,
      }));
    if (
      !globalThis.confirm(
        `Change the price of ${plural(rows.length, "product")}? There is no undo: to reverse it, run another mass change.`,
      )
    ) {
      return;
    }
    setBusy("apply");
    try {
      const res = await axios.post<MassChangeApplyResult>("/api/pricing/mass-change/apply", {
        rows,
        note: note.trim() || undefined,
      });
      setResult(res.data);
      setPreview(null);
      setNote("");
      clearSelection();
      reloadList();
    } catch (err) {
      toast.error(getErrorMessage(err, "The price change failed; nothing was changed."));
    } finally {
      setBusy(null);
    }
  };

  const lock = async (locked: boolean) => {
    setBusy("lock");
    try {
      const res = await axios.post<{ changed: number; unchanged: number; missing: number[] }>(
        "/api/pricing/mass-change/lock",
        { selection, locked },
      );
      const { changed, unchanged } = res.data;
      const verb = locked ? "locked" : "unlocked";
      toast.success(
        `${plural(changed, "price")} ${verb}${unchanged > 0 ? `; ${unchanged.toLocaleString()} already were` : ""}.`,
      );
      setPreview(null);
      reloadList();
    } catch (err) {
      toast.error(getErrorMessage(err, "The price locks weren't changed."));
    } finally {
      setBusy(null);
    }
  };

  const tooMany = count > MASS_CHANGE_MAX_PRODUCTS;
  const changeIsKeep = retailKind === "KEEP" && was === "KEEP";

  return (
    <div className="py-2 space-y-6 font-serif">
      <div className="flex items-center gap-3">
        <Link href="/app/inventory" className="text-brand-blue hover:underline text-sm">
          Inventory
        </Link>
        <span className="text-brand-gray">/</span>
        <h1 className="text-2xl font-semibold text-brand-blue">Mass Price Change</h1>
      </div>

      <p className="text-sm text-brand-gray">
        Choose products, say how their retail and was price change, and preview before anything is
        saved. Locked prices are kept. Every change goes in the product&apos;s price history.
        Markups and rounding are set in Admin → Settings → Pricing, and on each vendor and category.
      </p>

      <FilterBar options={options} filter={filter} onFilter={changeFilter} />

      <div className="bg-brand-linen border border-brand-gray/20 rounded-lg p-4 space-y-4">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <p className="font-semibold text-brand-blue">
            {allMatching
              ? `All ${plural(total, "product")} matching the filter`
              : `${plural(selected.size, "product")} chosen`}
          </p>
          {!allMatching && total > 0 && (
            <button
              onClick={() => setAllMatching(true)}
              disabled={total > MASS_CHANGE_MAX_PRODUCTS}
              className="text-brand-blue underline disabled:text-brand-gray disabled:no-underline"
            >
              Choose all {plural(total, "product")} matching the filter
            </button>
          )}
          {(allMatching || selected.size > 0) && (
            <button onClick={clearSelection} className="text-brand-gray underline">
              Clear
            </button>
          )}
        </div>
        {tooMany && (
          <p className="text-sm text-amber-800">
            A mass price change takes at most {MASS_CHANGE_MAX_PRODUCTS.toLocaleString()} products
            at a time. Narrow the filter or the selection.
          </p>
        )}
        {!allMatching && total > MASS_CHANGE_MAX_PRODUCTS && (
          <p className="text-xs text-brand-gray">
            The filter matches more than {MASS_CHANGE_MAX_PRODUCTS.toLocaleString()} products;
            narrow it to choose them all at once.
          </p>
        )}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <div>
            <label htmlFor="mpc-retail" className={labelCls}>
              Retail
            </label>
            <select
              id="mpc-retail"
              value={retailKind}
              onChange={(e) => setRetailKind(e.target.value as RetailKind)}
              className={fieldCls}
            >
              {retailKinds.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label}
                </option>
              ))}
            </select>
            {retailKind === "PERCENT" && (
              <div className="mt-2">
                <label htmlFor="mpc-percent" className="block text-xs text-brand-gray mb-1">
                  Percent (−10 takes 10% off; 5 adds 5%)
                </label>
                <input
                  id="mpc-percent"
                  type="number"
                  step="any"
                  value={percent}
                  onChange={(e) => setPercent(e.target.value)}
                  className={fieldCls}
                />
              </div>
            )}
            {retailKind === "AMOUNT" && (
              <div className="mt-2">
                <label htmlFor="mpc-amount" className="block text-xs text-brand-gray mb-1">
                  New retail price, to the cent
                </label>
                <input
                  id="mpc-amount"
                  type="number"
                  min={0.01}
                  step={0.01}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className={fieldCls}
                />
              </div>
            )}
          </div>
          <div>
            <label htmlFor="mpc-was" className={labelCls}>
              Was price
            </label>
            <select
              id="mpc-was"
              value={was}
              onChange={(e) => setWas(e.target.value as WasOperation)}
              className={fieldCls}
            >
              {WAS_CHOICES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="mpc-rounding" className={labelCls}>
              Rounding
            </label>
            <select
              id="mpc-rounding"
              value={rounding}
              disabled={retailKind === "AMOUNT" || retailKind === "KEEP"}
              onChange={(e) => setRounding(isRetailRounding(e.target.value) ? e.target.value : "")}
              className={`${fieldCls} disabled:bg-brand-linen disabled:text-brand-gray`}
            >
              <option value="">The store&apos;s rule</option>
              {RETAIL_ROUNDINGS.map((r) => (
                <option key={r} value={r}>
                  {RETAIL_ROUNDING_LABELS[r]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={runPreview}
            disabled={count === 0 || tooMany || changeIsKeep || busy !== null}
            className="min-h-[40px] px-6"
          >
            {busy === "preview" ? "Working it out…" : "Preview"}
          </Button>
          <Button
            variant="outline"
            onClick={() => lock(true)}
            disabled={count === 0 || tooMany || busy !== null}
            className="min-h-[40px]"
          >
            <Lock className="mr-2 h-4 w-4" aria-hidden /> Lock prices
          </Button>
          <Button
            variant="outline"
            onClick={() => lock(false)}
            disabled={count === 0 || tooMany || busy !== null}
            className="min-h-[40px]"
          >
            <LockOpen className="mr-2 h-4 w-4" aria-hidden /> Unlock prices
          </Button>
          {changeIsKeep && (
            <span className="text-xs text-brand-gray">
              Pick a change to retail or the was price to preview.
            </span>
          )}
        </div>
      </div>

      {result && <ResultPanel result={result} onDismiss={() => setResult(null)} />}

      {currentPreview && (
        <PreviewPanel
          preview={currentPreview}
          applying={busy === "apply"}
          note={note}
          onNote={setNote}
          onApply={apply}
        />
      )}

      <ProductTable
        rows={list?.rows ?? []}
        loading={loading}
        total={total}
        page={page}
        costVisible={list?.costVisible ?? false}
        selected={selected}
        allMatching={allMatching}
        onToggle={toggleRow}
        onToggleAllOnPage={toggleAllOnPage}
        onPage={setPage}
      />
    </div>
  );
}
