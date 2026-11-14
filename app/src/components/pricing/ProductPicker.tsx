"use client";

// /app/src/components/pricing/ProductPicker.tsx
//
// Choosing products to price, shared by the mass price change and the Sales
// screen (GAP-06): filter the catalog by vendor, department, category, text and
// lock, page through it, tick rows (kept across pages, like Categorize Products)
// or take everything the filter matches. The list is GET /api/pricing/mass-change
// (active products, regular retail, cost only to "View cost"); the selection is
// the MassChangeSelection both previews take, so the server resolves "everything
// the filter matches" again and caps it (lib/pricing/massChangeShared.ts).

import { useCallback, useEffect, useMemo, useState } from "react";
import axios from "axios";
import Link from "next/link";
import { toast } from "react-toastify";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { getErrorMessage } from "@/lib/toastError";
import {
  MASS_CHANGE_MAX_PRODUCTS,
  type MassChangeFilter,
  type MassChangeSelection,
} from "@/lib/pricing/massChangeShared";

export const PICKER_PAGE_SIZE = 50;

interface Named {
  id: number;
  name: string;
}

export interface PickerOptions {
  vendors: Named[];
  departments: Named[];
  categories: (Named & { departmentId: number })[];
}

export interface PickerRow {
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

export interface PickerList {
  total: number;
  page: number;
  pageSize: number;
  costVisible: boolean;
  rows: PickerRow[];
}

const LOCKED_CHOICES = [
  { value: "", label: "Locked or not" },
  { value: "unlocked", label: "Not locked" },
  { value: "locked", label: "Locked" },
] as const;

export const pickerFieldCls =
  "w-full border border-brand-gray/30 rounded-lg px-3 py-2 text-sm text-brand-black min-h-[40px] bg-white focus:outline-none focus:ring-1 focus:ring-brand-blue";
export const pickerLabelCls =
  "block text-xs font-semibold text-brand-gray uppercase tracking-wide mb-1";

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

const idOrUndefined = (value: string) => (value ? Number(value) : undefined);

/** The filter, the page of products it shows, and which are chosen. */
export function useProductPicker() {
  const [options, setOptions] = useState<PickerOptions | null>(null);
  const [filter, setFilter] = useState<MassChangeFilter>({});
  const [page, setPage] = useState(1);
  const [list, setList] = useState<PickerList | null>(null);
  // The list answers for one filter, page and reload; loading until it has.
  const [reloadTick, setReloadTick] = useState(0);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const listKey = JSON.stringify({ filter, page, reloadTick });
  const loading = loadedKey !== listKey;
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [allMatching, setAllMatching] = useState(false);

  useEffect(() => {
    axios
      .get<PickerOptions>("/api/pricing/mass-change/options")
      .then((res) => setOptions(res.data))
      .catch((err) =>
        toast.error(getErrorMessage(err, "Couldn't load the vendors and categories.")),
      );
  }, []);

  useEffect(() => {
    let live = true;
    axios
      .get<PickerList>("/api/pricing/mass-change", {
        params: { ...filter, page, pageSize: PICKER_PAGE_SIZE },
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

  const reload = useCallback(() => setReloadTick((n) => n + 1), []);

  const changeFilter = useCallback((next: MassChangeFilter) => {
    setFilter(next);
    setPage(1);
  }, []);

  const toggleRow = useCallback((id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAllOnPage = useCallback(() => {
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
  }, [list]);

  const clearSelection = useCallback(() => {
    setSelected(new Set());
    setAllMatching(false);
  }, []);

  const total = list?.total ?? 0;
  const count = allMatching ? total : selected.size;

  const selection: MassChangeSelection = useMemo(
    () => (allMatching ? { filter } : { productIds: [...selected].sort((a, b) => a - b) }),
    [allMatching, filter, selected],
  );

  return {
    options,
    filter,
    changeFilter,
    page,
    setPage,
    list,
    loading,
    reload,
    selected,
    allMatching,
    chooseAllMatching: () => setAllMatching(true),
    toggleRow,
    toggleAllOnPage,
    clearSelection,
    total,
    count,
    tooMany: count > MASS_CHANGE_MAX_PRODUCTS,
    selection,
  };
}

export type ProductPicker = ReturnType<typeof useProductPicker>;

export function FilterBar({
  options,
  filter,
  onFilter,
  idPrefix,
}: Readonly<{
  options: PickerOptions | null;
  filter: MassChangeFilter;
  onFilter: (next: MassChangeFilter) => void;
  /** Keeps the field ids apart when two pickers could share a page. */
  idPrefix: string;
}>) {
  const [searchInput, setSearchInput] = useState(filter.q ?? "");
  const categories = useMemo(
    () =>
      (options?.categories ?? []).filter(
        (c) => !filter.departmentId || c.departmentId === filter.departmentId,
      ),
    [options, filter.departmentId],
  );
  const id = (name: string) => `${idPrefix}-${name}`;
  return (
    <div className="bg-white border border-brand-gray/20 rounded-lg p-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div>
          <label htmlFor={id("vendor")} className={pickerLabelCls}>
            Vendor
          </label>
          <select
            id={id("vendor")}
            value={filter.vendorId ?? ""}
            onChange={(e) => onFilter({ ...filter, vendorId: idOrUndefined(e.target.value) })}
            className={pickerFieldCls}
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
          <label htmlFor={id("department")} className={pickerLabelCls}>
            Department
          </label>
          <select
            id={id("department")}
            value={filter.departmentId ?? ""}
            onChange={(e) =>
              onFilter({
                ...filter,
                departmentId: idOrUndefined(e.target.value),
                categoryId: undefined,
              })
            }
            className={pickerFieldCls}
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
          <label htmlFor={id("category")} className={pickerLabelCls}>
            Category
          </label>
          <select
            id={id("category")}
            value={filter.categoryId ?? ""}
            onChange={(e) => onFilter({ ...filter, categoryId: idOrUndefined(e.target.value) })}
            className={pickerFieldCls}
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
          <label htmlFor={id("locked")} className={pickerLabelCls}>
            Price lock
          </label>
          <select
            id={id("locked")}
            value={filter.locked ?? ""}
            onChange={(e) =>
              onFilter({
                ...filter,
                locked:
                  e.target.value === "" ? undefined : (e.target.value as "locked" | "unlocked"),
              })
            }
            className={pickerFieldCls}
          >
            {LOCKED_CHOICES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={id("search")} className={pickerLabelCls}>
            Name or part #
          </label>
          <div className="flex gap-2">
            <input
              id={id("search")}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onFilter({ ...filter, q: searchInput.trim() || undefined });
              }}
              placeholder="e.g. sofa, 1234"
              className={pickerFieldCls}
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

/** How many are chosen, "choose all matching", clear, and the cap. */
export function SelectionSummary({
  picker,
  capFor,
}: Readonly<{
  picker: ProductPicker;
  /** Who the cap belongs to, for its message: "A mass price change", "A sale". */
  capFor: string;
}>) {
  const { allMatching, total, selected, tooMany } = picker;
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <p className="font-semibold text-brand-blue">
          {allMatching
            ? `All ${plural(total, "product")} matching the filter`
            : `${plural(selected.size, "product")} chosen`}
        </p>
        {!allMatching && total > 0 && (
          <button
            onClick={picker.chooseAllMatching}
            disabled={total > MASS_CHANGE_MAX_PRODUCTS}
            className="text-brand-blue underline disabled:text-brand-gray disabled:no-underline"
          >
            Choose all {plural(total, "product")} matching the filter
          </button>
        )}
        {(allMatching || selected.size > 0) && (
          <button onClick={picker.clearSelection} className="text-brand-gray underline">
            Clear
          </button>
        )}
      </div>
      {tooMany && (
        <p className="text-sm text-amber-800">
          {capFor} takes at most {MASS_CHANGE_MAX_PRODUCTS.toLocaleString()} products at a time.
          Narrow the filter or the selection.
        </p>
      )}
      {!allMatching && total > MASS_CHANGE_MAX_PRODUCTS && (
        <p className="text-xs text-brand-gray">
          The filter matches more than {MASS_CHANGE_MAX_PRODUCTS.toLocaleString()} products; narrow
          it to choose them all at once.
        </p>
      )}
    </>
  );
}

export function ProductTable({ picker }: Readonly<{ picker: ProductPicker }>) {
  const fmt = useMoneyFormatter();
  const { list, loading, total, page, selected, allMatching } = picker;
  const rows = list?.rows ?? [];
  const costVisible = list?.costVisible ?? false;
  const totalPages = Math.max(1, Math.ceil(total / PICKER_PAGE_SIZE));
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
            onClick={() => picker.setPage(Math.max(1, page - 1))}
            disabled={page === 1}
            className="px-2 py-1 text-sm text-brand-blue disabled:text-brand-gray/50"
          >
            ← Prev
          </button>
          <button
            onClick={() => picker.setPage(Math.min(totalPages, page + 1))}
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
                  onChange={picker.toggleAllOnPage}
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
                    onClick={() => !allMatching && picker.toggleRow(r.id)}
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
                        onChange={() => picker.toggleRow(r.id)}
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
