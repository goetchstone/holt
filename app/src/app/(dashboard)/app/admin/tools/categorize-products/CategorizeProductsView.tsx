"use client";

// /app/src/app/(dashboard)/app/admin/tools/categorize-products/CategorizeProductsView.tsx
//
// Bulk categorization tool: filter down to Uncategorized products, select a
// batch, and assign department / category / type / vendor in one shot. Reads
// the shared /api/admin/uncategorized-products + /api/admin/bulk-categorize REST
// endpoints. Chrome from the (dashboard) layout.

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import TaxonomyPicker from "@/components/form/TaxonomyPicker";
import { getErrorMessage } from "@/lib/toastError";

interface ProductRow {
  id: number;
  name: string;
  productNumber: string;
  vendorId: number | null;
  vendorName: string | null;
  departmentId: number | null;
  departmentName: string | null;
  categoryId: number | null;
  categoryName: string | null;
  typeId: number | null;
  typeName: string | null;
}

interface ListResponse {
  products: ProductRow[];
  total: number;
  page: number;
  limit: number;
}

interface TaxonomySelection {
  vendorId: number | null;
  departmentId: number | null;
  categoryId: number | null;
  typeId: number | null;
}

const PAGE_SIZE = 50;

const EMPTY_TAXONOMY: TaxonomySelection = {
  vendorId: null,
  departmentId: null,
  categoryId: null,
  typeId: null,
};

function ProductTableRow({
  product,
  selected,
  onToggle,
}: Readonly<{ product: ProductRow; selected: boolean; onToggle: (id: number) => void }>) {
  const deptClass = product.departmentName === "Uncategorized" ? "text-amber-700" : "text-sh-black";
  return (
    <tr
      onClick={() => onToggle(product.id)}
      className={`border-b border-sh-gray/10 cursor-pointer transition ${
        selected ? "bg-sh-linen" : "hover:bg-sh-stripe"
      }`}
    >
      <td className="px-3 py-2">
        <input
          type="checkbox"
          aria-label={`Select ${product.name}`}
          checked={selected}
          onChange={() => onToggle(product.id)}
          onClick={(e) => e.stopPropagation()}
        />
      </td>
      <td className="px-3 py-2 text-sh-black max-w-[300px] truncate">{product.name}</td>
      <td className="px-3 py-2 font-mono text-xs text-sh-gray">{product.productNumber}</td>
      <td className="px-3 py-2 text-sh-black">{product.vendorName ?? "—"}</td>
      <td className={`px-3 py-2 ${deptClass}`}>{product.departmentName ?? "—"}</td>
      <td className="px-3 py-2 text-sh-gray">{product.categoryName ?? "—"}</td>
    </tr>
  );
}

export function CategorizeProductsView() {
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [onlyUncategorized, setOnlyUncategorized] = useState(true);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [taxonomy, setTaxonomy] = useState<TaxonomySelection>(EMPTY_TAXONOMY);
  const [applying, setApplying] = useState(false);

  const loadProducts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await axios.get<ListResponse>("/api/admin/uncategorized-products", {
        params: {
          page,
          limit: PAGE_SIZE,
          search: search || undefined,
          onlyUncategorized: onlyUncategorized ? "true" : "false",
        },
      });
      setProducts(res.data.products);
      setTotal(res.data.total);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to load products."));
    } finally {
      setLoading(false);
    }
  }, [page, search, onlyUncategorized]);

  useEffect(() => {
    loadProducts();
  }, [loadProducts]);

  const toggleRow = useCallback((id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  function toggleAllOnPage() {
    setSelected((prev) => {
      const next = new Set(prev);
      const allSelected = products.every((p) => next.has(p.id));
      if (allSelected) {
        for (const p of products) next.delete(p.id);
      } else {
        for (const p of products) next.add(p.id);
      }
      return next;
    });
  }

  function runSearch() {
    setSearch(searchInput);
    setPage(1);
  }

  async function applyChanges() {
    if (selected.size === 0) return;
    if (!taxonomy.departmentId && !taxonomy.vendorId && !taxonomy.categoryId && !taxonomy.typeId) {
      toast.warn("Pick at least one taxonomy field to apply.");
      return;
    }
    setApplying(true);
    try {
      const res = await axios.post<{ updated: number }>("/api/admin/bulk-categorize", {
        productIds: Array.from(selected),
        vendorId: taxonomy.vendorId ?? undefined,
        departmentId: taxonomy.departmentId ?? undefined,
        categoryId: taxonomy.categoryId ?? undefined,
        typeId: taxonomy.typeId ?? null, // explicit null = clear type
      });
      toast.success(`Updated ${res.data.updated} product${res.data.updated === 1 ? "" : "s"}.`);
      setSelected(new Set());
      setTaxonomy(EMPTY_TAXONOMY);
      await loadProducts();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Bulk update failed."));
    } finally {
      setApplying(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const allSelectedOnPage = products.length > 0 && products.every((p) => selected.has(p.id));

  return (
    <div className="py-2 space-y-6 font-serif">
      <div className="flex items-center gap-3">
        <Link href="/app/admin/tools" className="text-sh-blue hover:underline text-sm">
          Admin Tools
        </Link>
        <span className="text-sh-gray">/</span>
        <h1 className="text-2xl font-semibold text-sh-blue">Categorize Products</h1>
      </div>

      <p className="text-sm text-sh-gray">
        Assign department, category, vendor, and type to products in bulk. Rows default-filter to
        those in the &quot;Uncategorized&quot; department so you can clean up imports quickly.
      </p>

      {/* Filter bar */}
      <div className="bg-white border border-sh-gray/20 rounded-lg p-4 space-y-3">
        <div className="flex items-end gap-3 flex-wrap">
          <div className="flex-1 min-w-[200px]">
            <label
              htmlFor="categorize-search"
              className="block text-xs font-semibold text-sh-gray uppercase tracking-wide mb-1"
            >
              Search (name / part no)
            </label>
            <input
              id="categorize-search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") runSearch();
              }}
              placeholder="e.g. sofa, Marjan, 9381"
              className="w-full border border-sh-gray/30 rounded-lg px-3 py-2 text-sm text-sh-black min-h-[40px] focus:outline-none focus:ring-1 focus:ring-sh-blue"
            />
          </div>
          <Button onClick={runSearch} className="min-h-[40px] px-4">
            Filter
          </Button>
          <label
            htmlFor="categorize-only-uncategorized"
            className="flex items-center gap-2 text-sm text-sh-black min-h-[40px] cursor-pointer"
          >
            <input
              id="categorize-only-uncategorized"
              type="checkbox"
              checked={onlyUncategorized}
              onChange={(e) => {
                setOnlyUncategorized(e.target.checked);
                setPage(1);
              }}
            />
            Only &quot;Uncategorized&quot; dept
          </label>
        </div>
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="bg-sh-linen border border-sh-blue/40 rounded-lg p-4 space-y-3">
          <p className="text-sm font-semibold text-sh-blue">
            Assign to {selected.size.toLocaleString()} selected product
            {selected.size === 1 ? "" : "s"}
          </p>
          <TaxonomyPicker
            vendorId={taxonomy.vendorId}
            departmentId={taxonomy.departmentId}
            categoryId={taxonomy.categoryId}
            typeId={taxonomy.typeId}
            onChange={setTaxonomy}
            requireVendor={false}
          />
          <div className="flex gap-2 items-center">
            <Button onClick={applyChanges} disabled={applying} className="min-h-[40px] px-6">
              {applying ? "Applying…" : `Apply to ${selected.size}`}
            </Button>
            <button
              onClick={() => setSelected(new Set())}
              className="text-sm text-sh-gray hover:text-sh-black underline"
            >
              Clear selection
            </button>
          </div>
        </div>
      )}

      {/* Products table */}
      <div className="bg-white border border-sh-gray/20 rounded-lg overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2 border-b border-sh-gray/20 bg-sh-linen">
          <p className="text-sm text-sh-gray">
            {loading
              ? "Loading…"
              : `${total.toLocaleString()} product${total === 1 ? "" : "s"} — page ${page} of ${totalPages}`}
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="px-2 py-1 text-sm text-sh-blue disabled:text-sh-gray/50"
            >
              ← Prev
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="px-2 py-1 text-sm text-sh-blue disabled:text-sh-gray/50"
            >
              Next →
            </button>
          </div>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-sh-gray/20 text-left text-xs text-sh-gray uppercase tracking-wide">
              <th className="px-3 py-2 w-8">
                <input
                  type="checkbox"
                  aria-label="Select all products on this page"
                  checked={allSelectedOnPage}
                  onChange={toggleAllOnPage}
                />
              </th>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Part #</th>
              <th className="px-3 py-2">Vendor</th>
              <th className="px-3 py-2">Department</th>
              <th className="px-3 py-2">Category</th>
            </tr>
          </thead>
          <tbody>
            {!loading && products.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-sh-gray">
                  No products match.
                </td>
              </tr>
            ) : (
              products.map((p) => (
                <ProductTableRow
                  key={p.id}
                  product={p}
                  selected={selected.has(p.id)}
                  onToggle={toggleRow}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
