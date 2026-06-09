"use client";

// /app/src/app/(dashboard)/app/admin/pricing/style-editor/StyleEditorView.tsx
//
// Style Editor body. App Router port of the legacy admin/pricing/style-editor
// body (minus MainLayout chrome, which the (dashboard) layout supplies). Pick a
// vendor, search/filter its imported styles, click a row to edit via
// StyleEditModal. Styles load from the shared /api/pricing/products REST
// endpoint, which stays REST.

import { useState, useEffect, useCallback, useMemo } from "react";
import StyleEditModal from "@/components/modals/StyleEditModal";
import PaginationControls from "@/components/table/PaginationControls";
import { getErrorMessage } from "@/lib/toastError";
import { toast } from "react-toastify";
import { Loader2, Search, Pencil, ImageOff, Image as ImageIcon, ChevronDown } from "lucide-react";
import {
  Combobox,
  ComboboxInput,
  ComboboxButton,
  ComboboxOptions,
  ComboboxOption,
} from "@headlessui/react";

// ─── Types ─────────────────────────────────────────────────────────

interface Vendor {
  id: number;
  name: string;
  pricingModel: string;
}

interface StyleRow {
  id: number;
  productNumber: string;
  name: string;
  description: string | null;
  baseCost: string | number | null;
  width: number | null;
  depth: number | null;
  height: number | null;
  seatHeight: number | null;
  armHeight: number | null;
  seatDepth: number | null;
  finish: string | null;
  standardSeat: string | null;
  standardBack: string | null;
  standardPillows: string | null;
  comYardage: string | number | null;
  comYardagePattern: string | number | null;
  comYardageRepeat: string | number | null;
  imageUrl: string | null;
  gradePrices: { tierCode: string; cost: number }[];
  availableOptions: {
    optionName: string;
    isStandard: boolean;
    surcharge: number;
    isAvailable: boolean;
  }[];
}

const ROWS_PER_PAGE = 25;

// ─── Pure helpers ──────────────────────────────────────────────────

function formatDimensions(s: StyleRow): string {
  const dims: string[] = [];
  if (s.width) dims.push(`${s.width}"W`);
  if (s.depth) dims.push(`${s.depth}"D`);
  if (s.height) dims.push(`${s.height}"H`);
  if (dims.length === 0) return "--";
  let result = dims.join(" x ");
  const extras: string[] = [];
  if (s.seatHeight) extras.push(`SH: ${s.seatHeight}"`);
  if (s.armHeight) extras.push(`AH: ${s.armHeight}"`);
  if (s.seatDepth) extras.push(`SD: ${s.seatDepth}"`);
  if (extras.length > 0) result += ` (${extras.join(", ")})`;
  return result;
}

function formatYardage(s: StyleRow): string {
  if (!s.comYardage && !s.comYardagePattern && !s.comYardageRepeat) return "--";
  const parts: string[] = [];
  if (s.comYardage) parts.push(`${Number(s.comYardage)} plain`);
  if (s.comYardagePattern) parts.push(`${Number(s.comYardagePattern)} patt`);
  if (s.comYardageRepeat) parts.push(`${Number(s.comYardageRepeat)} rpt`);
  return parts.join(" / ");
}

function formatOptionsSummary(s: StyleRow): string {
  const included = s.availableOptions.filter((o) => o.isStandard).map((o) => o.optionName);
  if (included.length === 0) return "--";
  return included.join(", ");
}

// ─── Sub-components ─────────────────────────────────────────────────

function StyleThumbnail({ imageUrl }: Readonly<{ imageUrl: string | null }>) {
  if (imageUrl) {
    return (
      <div className="w-8 h-8 rounded overflow-hidden bg-sh-linen flex items-center justify-center">
        {/* eslint-disable-next-line @next/next/no-img-element -- vendor image URLs are arbitrary remote hosts; no next/image loader configured for them */}
        <img src={imageUrl} alt="" className="w-full h-full object-contain" />
      </div>
    );
  }
  return (
    <div className="w-8 h-8 rounded bg-sh-linen flex items-center justify-center">
      <ImageIcon className="w-4 h-4 text-sh-gray/40" />
    </div>
  );
}

function StyleTableRow({ style, onEdit }: Readonly<{ style: StyleRow; onEdit: () => void }>) {
  return (
    <tr
      onClick={onEdit}
      className="border-t border-sh-gray/10 hover:bg-sh-linen/40 cursor-pointer transition"
    >
      <td className="px-3 py-2.5">
        <StyleThumbnail imageUrl={style.imageUrl} />
      </td>
      <td className="px-3 py-2.5 font-semibold text-sh-blue whitespace-nowrap">
        {style.productNumber}
      </td>
      <td className="px-3 py-2.5 text-sh-black max-w-[200px] truncate">{style.name}</td>
      <td className="px-3 py-2.5 text-sh-gray whitespace-nowrap">{formatDimensions(style)}</td>
      <td className="px-3 py-2.5 text-sh-gray max-w-[120px] truncate">{style.finish || "--"}</td>
      <td className="px-3 py-2.5 text-sh-gray whitespace-nowrap">{formatYardage(style)}</td>
      <td className="px-3 py-2.5 text-sh-gray max-w-[200px] truncate text-xs">
        {formatOptionsSummary(style)}
      </td>
      <td className="px-3 py-2.5 text-center">
        <Pencil className="w-4 h-4 text-sh-gray/50" />
      </td>
    </tr>
  );
}

// ─── Main view ─────────────────────────────────────────────────────

export function StyleEditorView() {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [selectedVendorId, setSelectedVendorId] = useState<number | null>(null);
  const [styles, setStyles] = useState<StyleRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [vendorsLoading, setVendorsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [editingStyleId, setEditingStyleId] = useState<number | null>(null);
  const [filterMissingImage, setFilterMissingImage] = useState(false);
  const [refreshCounter, setRefreshCounter] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [vendorQuery, setVendorQuery] = useState("");

  const loadVendors = useCallback(async () => {
    try {
      const res = await fetch("/api/vendors?all=true");
      if (res.ok) {
        const data = await res.json();
        const list: Vendor[] = data.vendors || data || [];
        setVendors(list);
        const wh = list.find((v) => v.name.toLowerCase().includes("wesley hall"));
        if (wh) setSelectedVendorId(wh.id);
        else if (list.length > 0) setSelectedVendorId(list[0].id);
      }
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to load vendors"));
    } finally {
      setVendorsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadVendors();
  }, [loadVendors]);

  const fetchStyles = useCallback(async () => {
    if (!selectedVendorId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/pricing/products?vendorId=${selectedVendorId}`);
      if (!res.ok) {
        toast.error("Failed to load styles");
        return;
      }
      const data = await res.json();
      setStyles(data.products || []);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to load styles"));
    } finally {
      setLoading(false);
    }
  }, [selectedVendorId]);

  useEffect(() => {
    fetchStyles();
  }, [fetchStyles, refreshCounter]);

  const selectedVendor = vendors.find((v) => v.id === selectedVendorId) || null;

  const filteredVendors = useMemo(() => {
    if (!vendorQuery) return vendors;
    const q = vendorQuery.toLowerCase();
    return vendors.filter((v) => v.name.toLowerCase().includes(q));
  }, [vendors, vendorQuery]);

  const filteredStyles = useMemo(
    () =>
      styles.filter((s) => {
        const q = searchQuery.toLowerCase();
        const matchesSearch =
          !q ||
          s.productNumber.toLowerCase().includes(q) ||
          s.name.toLowerCase().includes(q) ||
          (s.description || "").toLowerCase().includes(q);
        const matchesFilter = !filterMissingImage || !s.imageUrl;
        return matchesSearch && matchesFilter;
      }),
    [styles, searchQuery, filterMissingImage],
  );

  // Reset to page 1 when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, filterMissingImage, selectedVendorId]);

  const pageStart = (currentPage - 1) * ROWS_PER_PAGE;
  const pageEnd = pageStart + ROWS_PER_PAGE;
  const pagedStyles = filteredStyles.slice(pageStart, pageEnd);

  const handleStyleSaved = () => {
    setEditingStyleId(null);
    setRefreshCounter((c) => c + 1);
  };

  const showEmpty = selectedVendorId && filteredStyles.length === 0;

  return (
    <div className="py-2 font-serif space-y-4">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold text-sh-blue mb-1">Style Editor</h1>
        <p className="text-sh-gray text-sm">
          View and correct imported style data. Click a row to edit.
        </p>
      </div>

      {/* Vendor selector */}
      {vendorsLoading ? (
        <div className="flex items-center gap-2 text-sh-gray text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading vendors...
        </div>
      ) : (
        <div className="max-w-xs">
          <Combobox
            value={selectedVendor}
            onChange={(v: Vendor | null) => {
              if (v) {
                setSelectedVendorId(v.id);
                setSearchQuery("");
              }
            }}
          >
            <div className="relative">
              <ComboboxInput
                className="w-full border border-sh-gray/30 rounded-lg pl-3 pr-10 py-2 text-sm text-sh-black font-serif focus:border-sh-blue focus:ring-1 focus:ring-sh-blue outline-none"
                displayValue={(v: Vendor | null) => v?.name || ""}
                onChange={(e) => setVendorQuery(e.target.value)}
                placeholder="Select vendor..."
              />
              <ComboboxButton className="absolute inset-y-0 right-0 flex items-center pr-3">
                <ChevronDown className="w-4 h-4 text-sh-gray" />
              </ComboboxButton>
            </div>
            <ComboboxOptions className="absolute z-20 mt-1 max-h-60 w-full max-w-xs overflow-auto rounded-lg bg-white border border-sh-gray/20 shadow-lg py-1">
              {filteredVendors.length === 0 ? (
                <div className="px-3 py-2 text-sm text-sh-gray">No vendors found</div>
              ) : (
                filteredVendors.map((v) => (
                  <ComboboxOption
                    key={v.id}
                    value={v}
                    className="cursor-pointer select-none px-3 py-2 text-sm text-sh-black data-[focus]:bg-sh-linen data-[selected]:font-semibold data-[selected]:text-sh-blue"
                  >
                    {v.name}
                  </ComboboxOption>
                ))
              )}
            </ComboboxOptions>
          </Combobox>
        </div>
      )}

      {/* Search and filters */}
      {selectedVendorId && (
        <div className="flex items-center gap-3">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-sh-gray" />
            <input
              type="text"
              aria-label="Search styles"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by style number or name..."
              className="w-full pl-10 pr-3 py-2 border border-sh-gray/30 rounded-lg text-sm text-sh-black font-serif"
            />
          </div>
          <button
            type="button"
            onClick={() => setFilterMissingImage((v) => !v)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold transition ${
              filterMissingImage
                ? "bg-sh-blue text-white shadow-md"
                : "bg-white text-sh-gray border border-sh-gray/30 hover:border-sh-blue hover:text-sh-blue"
            }`}
          >
            <ImageOff className="w-4 h-4" />
            Missing Image
          </button>
          <span className="text-sm text-sh-gray">
            Showing {Math.min(pageStart + 1, filteredStyles.length)}-
            {Math.min(pageEnd, filteredStyles.length)} of {filteredStyles.length} styles
          </span>
        </div>
      )}

      {/* Table */}
      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-8 h-8 text-sh-blue animate-spin" />
        </div>
      )}

      {!loading && showEmpty && (
        <div className="text-center py-16 text-sh-gray">
          <p>{searchQuery ? "No styles match your search." : "No styles found."}</p>
        </div>
      )}

      {!loading && selectedVendorId && filteredStyles.length > 0 && (
        <>
          <div className="border border-sh-gray/20 rounded-lg overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-sh-linen text-sh-gray text-xs uppercase tracking-wider">
                    <th className="text-left px-3 py-2.5 font-medium w-10" aria-label="Image" />
                    <th className="text-left px-3 py-2.5 font-medium">Style</th>
                    <th className="text-left px-3 py-2.5 font-medium">Name</th>
                    <th className="text-left px-3 py-2.5 font-medium">Dimensions</th>
                    <th className="text-left px-3 py-2.5 font-medium">Finish</th>
                    <th className="text-left px-3 py-2.5 font-medium">Yardage</th>
                    <th className="text-left px-3 py-2.5 font-medium">Included Options</th>
                    <th className="text-center px-3 py-2.5 font-medium w-10" aria-label="Edit" />
                  </tr>
                </thead>
                <tbody>
                  {pagedStyles.map((s) => (
                    <StyleTableRow key={s.id} style={s} onEdit={() => setEditingStyleId(s.id)} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <PaginationControls
            totalCount={filteredStyles.length}
            currentPage={currentPage}
            onPageChange={setCurrentPage}
            rowsPerPage={ROWS_PER_PAGE}
          />
        </>
      )}

      {/* Edit modal */}
      {editingStyleId && (
        <StyleEditModal
          styleId={editingStyleId}
          onClose={() => setEditingStyleId(null)}
          onSaved={handleStyleSaved}
        />
      )}
    </div>
  );
}
