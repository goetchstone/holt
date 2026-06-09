"use client";

// /app/src/app/(dashboard)/app/admin/pricing/product-review/ProductReviewView.tsx
//
// Product Review body. App Router port of the legacy admin/pricing/product-review
// body (minus MainLayout chrome, which the (dashboard) layout supplies). Visual
// card/list review of imported products for spotting bad image assignments and
// style names; inline name edits + per-style image upload; click a card to open
// the full StyleEditModal. Styles load from the shared /api/pricing/products
// REST endpoint; saves hit /api/pricing/styles/* — all stay REST.

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import StyleEditModal from "@/components/modals/StyleEditModal";
import PaginationControls from "@/components/table/PaginationControls";
import { getErrorMessage } from "@/lib/toastError";
import { toast } from "react-toastify";
import {
  Loader2,
  Search,
  ImageOff,
  Image as ImageIcon,
  Upload,
  Pencil,
  Check,
  X,
  LayoutGrid,
  List,
} from "lucide-react";

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

type ViewMode = "grid" | "list";

const CARDS_PER_PAGE = 24;
const ROWS_PER_PAGE = 25;

// ─── Pure helpers ──────────────────────────────────────────────────

function formatDimensions(s: StyleRow): string {
  const dims: string[] = [];
  if (s.width) dims.push(`${s.width}"W`);
  if (s.depth) dims.push(`${s.depth}"D`);
  if (s.height) dims.push(`${s.height}"H`);
  return dims.length > 0 ? dims.join(" x ") : "--";
}

// ─── Inline name editor (shared by grid + list) ─────────────────────

interface InlineNameEditorProps {
  value: string;
  saving: boolean;
  inputClassName: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

function InlineNameEditor({
  value,
  saving,
  inputClassName,
  onChange,
  onSave,
  onCancel,
}: Readonly<InlineNameEditorProps>) {
  return (
    <div className="flex items-center gap-1">
      <input
        type="text"
        aria-label="Style name"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSave();
          if (e.key === "Escape") onCancel();
        }}
        autoFocus
        className={inputClassName}
      />
      <button
        type="button"
        aria-label="Save name"
        onClick={onSave}
        disabled={saving}
        className="p-0.5 text-green-600 hover:text-green-800"
      >
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
      </button>
      <button
        type="button"
        aria-label="Cancel editing"
        onClick={onCancel}
        className="p-0.5 text-sh-gray hover:text-sh-black"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

// ─── Grid card ──────────────────────────────────────────────────────

interface GridCardProps {
  style: StyleRow;
  isEditingName: boolean;
  editingNameValue: string;
  isSavingName: boolean;
  isUploadingImage: boolean;
  onOpenModal: () => void;
  onStartImageUpload: () => void;
  onStartNameEdit: () => void;
  onNameChange: (value: string) => void;
  onNameSave: () => void;
  onNameCancel: () => void;
}

function GridCardImage({
  style,
  isUploading,
  onOpenModal,
  onStartImageUpload,
}: Readonly<{
  style: StyleRow;
  isUploading: boolean;
  onOpenModal: () => void;
  onStartImageUpload: () => void;
}>) {
  return (
    <div
      className="relative aspect-square bg-sh-linen flex items-center justify-center cursor-pointer"
      role="button"
      tabIndex={0}
      onClick={onOpenModal}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpenModal();
        }
      }}
    >
      {isUploading && <Loader2 className="w-8 h-8 text-sh-blue animate-spin" />}
      {!isUploading && style.imageUrl && (
        // eslint-disable-next-line @next/next/no-img-element -- vendor image URLs are arbitrary remote hosts; no next/image loader configured for them
        <img
          src={style.imageUrl}
          alt={style.productNumber}
          className="w-full h-full object-contain p-2"
        />
      )}
      {!isUploading && !style.imageUrl && (
        <div className="text-center">
          <ImageIcon className="w-12 h-12 text-sh-gray/30 mx-auto" />
          <span className="text-xs text-sh-gray/50 mt-1 block">No image</span>
        </div>
      )}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onStartImageUpload();
        }}
        className="absolute top-2 right-2 p-1.5 rounded-lg bg-white/80 text-sh-gray hover:bg-sh-blue hover:text-white transition opacity-0 group-hover:opacity-100"
        title="Replace image"
        aria-label="Replace image"
      >
        <Upload className="w-4 h-4" />
      </button>
    </div>
  );
}

function GridCardName({
  style,
  isEditingName,
  editingNameValue,
  isSavingName,
  onStartNameEdit,
  onNameChange,
  onNameSave,
  onNameCancel,
}: Readonly<Omit<GridCardProps, "onOpenModal" | "onStartImageUpload" | "isUploadingImage">>) {
  if (isEditingName) {
    return (
      <div className="mt-1">
        <InlineNameEditor
          value={editingNameValue}
          saving={isSavingName}
          inputClassName="flex-1 border border-sh-blue/30 rounded px-1.5 py-0.5 text-xs text-sh-black min-w-0"
          onChange={onNameChange}
          onSave={onNameSave}
          onCancel={onNameCancel}
        />
      </div>
    );
  }
  return (
    <div
      className="flex items-center gap-1 mt-0.5 group/name cursor-pointer"
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        onStartNameEdit();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        e.stopPropagation();
        onStartNameEdit();
      }}
    >
      <span className="text-xs text-sh-gray truncate flex-1">{style.name || "--"}</span>
      <Pencil className="w-3 h-3 text-sh-gray/40 opacity-0 group-hover/name:opacity-100 transition flex-shrink-0" />
    </div>
  );
}

function GridCard(props: Readonly<GridCardProps>) {
  return (
    <div className="border border-sh-gray/20 rounded-lg overflow-hidden shadow-sm bg-white hover:shadow-md transition group">
      <GridCardImage
        style={props.style}
        isUploading={props.isUploadingImage}
        onOpenModal={props.onOpenModal}
        onStartImageUpload={props.onStartImageUpload}
      />
      <div className="px-3 py-2 border-t border-sh-gray/10">
        <div className="font-semibold text-sh-blue text-sm">{props.style.productNumber}</div>
        <GridCardName
          style={props.style}
          isEditingName={props.isEditingName}
          editingNameValue={props.editingNameValue}
          isSavingName={props.isSavingName}
          onStartNameEdit={props.onStartNameEdit}
          onNameChange={props.onNameChange}
          onNameSave={props.onNameSave}
          onNameCancel={props.onNameCancel}
        />
        <div className="text-xs text-sh-gray/60 mt-0.5 truncate">
          {formatDimensions(props.style)}
        </div>
      </div>
    </div>
  );
}

// ─── List row ───────────────────────────────────────────────────────

interface ListRowProps {
  style: StyleRow;
  isEditingName: boolean;
  editingNameValue: string;
  isSavingName: boolean;
  isUploadingImage: boolean;
  onOpenModal: () => void;
  onStartImageUpload: () => void;
  onStartNameEdit: () => void;
  onNameChange: (value: string) => void;
  onNameSave: () => void;
  onNameCancel: () => void;
}

function ListRowName({
  style,
  isEditingName,
  editingNameValue,
  isSavingName,
  onStartNameEdit,
  onNameChange,
  onNameSave,
  onNameCancel,
}: Readonly<Omit<ListRowProps, "onOpenModal" | "onStartImageUpload" | "isUploadingImage">>) {
  if (isEditingName) {
    return (
      <InlineNameEditor
        value={editingNameValue}
        saving={isSavingName}
        inputClassName="flex-1 border border-sh-blue/30 rounded px-2 py-1 text-sm text-sh-black min-w-0"
        onChange={onNameChange}
        onSave={onNameSave}
        onCancel={onNameCancel}
      />
    );
  }
  return (
    <span
      className="text-sh-black cursor-pointer hover:text-sh-blue group/name inline-flex items-center gap-1"
      role="button"
      tabIndex={0}
      onClick={onStartNameEdit}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        onStartNameEdit();
      }}
    >
      {style.name || "--"}
      <Pencil className="w-3 h-3 text-sh-gray/40 opacity-0 group-hover/name:opacity-100 transition" />
    </span>
  );
}

function ListRow(props: Readonly<ListRowProps>) {
  return (
    <tr className="border-t border-sh-gray/10 hover:bg-sh-linen/40 transition">
      <td className="px-3 py-2">
        <div className="w-12 h-12 rounded overflow-hidden bg-sh-linen flex items-center justify-center">
          {props.style.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- vendor image URLs are arbitrary remote hosts; no next/image loader configured for them
            <img src={props.style.imageUrl} alt="" className="w-full h-full object-contain" />
          ) : (
            <ImageIcon className="w-5 h-5 text-sh-gray/30" />
          )}
        </div>
      </td>
      <td className="px-3 py-2 font-semibold text-sh-blue whitespace-nowrap">
        {props.style.productNumber}
      </td>
      <td className="px-3 py-2">
        <ListRowName
          style={props.style}
          isEditingName={props.isEditingName}
          editingNameValue={props.editingNameValue}
          isSavingName={props.isSavingName}
          onStartNameEdit={props.onStartNameEdit}
          onNameChange={props.onNameChange}
          onNameSave={props.onNameSave}
          onNameCancel={props.onNameCancel}
        />
      </td>
      <td className="px-3 py-2 text-sh-gray whitespace-nowrap">{formatDimensions(props.style)}</td>
      <td className="px-3 py-2 text-sh-gray">{props.style.finish || "--"}</td>
      <td className="px-3 py-2">
        <div className="flex items-center justify-center gap-1">
          <button
            type="button"
            onClick={props.onStartImageUpload}
            className="p-1.5 rounded text-sh-gray hover:text-sh-blue hover:bg-sh-linen transition"
            title="Replace image"
            aria-label="Replace image"
          >
            {props.isUploadingImage ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Upload className="w-4 h-4" />
            )}
          </button>
          <button
            type="button"
            onClick={props.onOpenModal}
            className="p-1.5 rounded text-sh-gray hover:text-sh-blue hover:bg-sh-linen transition"
            title="Edit all fields"
            aria-label="Edit all fields"
          >
            <Pencil className="w-4 h-4" />
          </button>
        </div>
      </td>
    </tr>
  );
}

// ─── Vendor selector + toolbar ──────────────────────────────────────

function VendorSelector({
  vendors,
  selectedVendorId,
  onSelect,
}: Readonly<{
  vendors: Vendor[];
  selectedVendorId: number | null;
  onSelect: (id: number) => void;
}>) {
  return (
    <div className="flex flex-wrap gap-3">
      {vendors.map((v) => (
        <button
          key={v.id}
          type="button"
          onClick={() => onSelect(v.id)}
          className={`px-4 py-2 rounded-lg text-sm font-semibold transition ${
            selectedVendorId === v.id
              ? "bg-sh-blue text-white shadow-md"
              : "bg-white text-sh-gray border border-sh-gray/30 hover:border-sh-blue hover:text-sh-blue"
          }`}
        >
          {v.name}
        </button>
      ))}
    </div>
  );
}

interface ToolbarProps {
  searchQuery: string;
  filterMissingImage: boolean;
  viewMode: ViewMode;
  missingCount: number;
  filteredCount: number;
  totalCount: number;
  imageCount: number;
  onSearchChange: (value: string) => void;
  onToggleMissing: () => void;
  onViewModeChange: (mode: ViewMode) => void;
}

function Toolbar(props: Readonly<ToolbarProps>) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <div className="relative flex-1 max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-sh-gray" />
        <input
          type="text"
          aria-label="Search styles"
          value={props.searchQuery}
          onChange={(e) => props.onSearchChange(e.target.value)}
          placeholder="Search by style number or name..."
          className="w-full pl-10 pr-3 py-2 border border-sh-gray/30 rounded-lg text-sm text-sh-black font-serif"
        />
      </div>
      <button
        type="button"
        onClick={props.onToggleMissing}
        className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold transition ${
          props.filterMissingImage
            ? "bg-sh-blue text-white shadow-md"
            : "bg-white text-sh-gray border border-sh-gray/30 hover:border-sh-blue hover:text-sh-blue"
        }`}
      >
        <ImageOff className="w-4 h-4" />
        Missing ({props.missingCount})
      </button>
      <div className="flex border border-sh-gray/30 rounded-lg overflow-hidden">
        <button
          type="button"
          aria-label="Grid view"
          aria-pressed={props.viewMode === "grid"}
          onClick={() => props.onViewModeChange("grid")}
          className={`px-3 py-2 transition ${
            props.viewMode === "grid"
              ? "bg-sh-blue text-white"
              : "bg-white text-sh-gray hover:bg-sh-linen"
          }`}
        >
          <LayoutGrid className="w-4 h-4" />
        </button>
        <button
          type="button"
          aria-label="List view"
          aria-pressed={props.viewMode === "list"}
          onClick={() => props.onViewModeChange("list")}
          className={`px-3 py-2 transition border-l border-sh-gray/30 ${
            props.viewMode === "list"
              ? "bg-sh-blue text-white"
              : "bg-white text-sh-gray hover:bg-sh-linen"
          }`}
        >
          <List className="w-4 h-4" />
        </button>
      </div>
      <span className="text-sm text-sh-gray">
        {props.filteredCount} of {props.totalCount} styles ({props.imageCount} with images)
      </span>
    </div>
  );
}

// ─── Main view ─────────────────────────────────────────────────────

export function ProductReviewView() {
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
  const [viewMode, setViewMode] = useState<ViewMode>("grid");

  // Inline name editing state
  const [editingNameId, setEditingNameId] = useState<number | null>(null);
  const [editingNameValue, setEditingNameValue] = useState("");
  const [savingNameId, setSavingNameId] = useState<number | null>(null);

  // Image upload state
  const [uploadingImageId, setUploadingImageId] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetIdRef = useRef<number | null>(null);

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

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, filterMissingImage, selectedVendorId]);

  const itemsPerPage = viewMode === "grid" ? CARDS_PER_PAGE : ROWS_PER_PAGE;
  const pageStart = (currentPage - 1) * itemsPerPage;
  const pageEnd = pageStart + itemsPerPage;
  const pagedStyles = filteredStyles.slice(pageStart, pageEnd);

  const handleStyleSaved = useCallback(() => {
    setEditingStyleId(null);
    setRefreshCounter((c) => c + 1);
  }, []);

  const startNameEdit = useCallback((style: StyleRow) => {
    setEditingNameId(style.id);
    setEditingNameValue(style.name);
  }, []);

  const handleInlineNameSave = useCallback(async () => {
    const styleId = editingNameId;
    if (styleId === null) return;
    setSavingNameId(styleId);
    try {
      const res = await fetch(`/api/pricing/styles/${styleId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fields: { name: editingNameValue },
          optionOverrides: [],
        }),
      });
      if (!res.ok) {
        toast.error("Failed to save name");
        return;
      }
      setStyles((prev) =>
        prev.map((s) => (s.id === styleId ? { ...s, name: editingNameValue } : s)),
      );
      setEditingNameId(null);
      toast.success("Name updated");
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to save name"));
    } finally {
      setSavingNameId(null);
    }
  }, [editingNameId, editingNameValue]);

  const startImageUpload = useCallback((styleId: number) => {
    uploadTargetIdRef.current = styleId;
    fileInputRef.current?.click();
  }, []);

  const handleImageUpload = useCallback(async (file: File) => {
    const styleId = uploadTargetIdRef.current;
    if (!styleId) return;

    setUploadingImageId(styleId);
    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch(`/api/pricing/styles/${styleId}/image`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || "Image upload failed");
        return;
      }

      const { imageUrl } = await res.json();
      setStyles((prev) => prev.map((s) => (s.id === styleId ? { ...s, imageUrl } : s)));
      toast.success("Image updated");
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Image upload failed"));
    } finally {
      setUploadingImageId(null);
      uploadTargetIdRef.current = null;
    }
  }, []);

  const imageCount = styles.filter((s) => s.imageUrl).length;
  const missingCount = styles.length - imageCount;

  const showEmpty = !loading && selectedVendorId && filteredStyles.length === 0;
  const showGrid = !loading && selectedVendorId && !showEmpty && viewMode === "grid";
  const showList = !loading && selectedVendorId && !showEmpty && viewMode === "list";

  return (
    <div className="py-2 font-serif space-y-4">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold text-sh-blue mb-1">Product Review</h1>
        <p className="text-sh-gray text-sm">
          Review imported products. Click a card for full editing, or use inline controls to fix
          names and images.
        </p>
      </div>

      {/* Vendor selector */}
      {vendorsLoading ? (
        <div className="flex items-center gap-2 text-sh-gray text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading vendors...
        </div>
      ) : (
        <VendorSelector
          vendors={vendors}
          selectedVendorId={selectedVendorId}
          onSelect={(id) => {
            setSelectedVendorId(id);
            setSearchQuery("");
          }}
        />
      )}

      {/* Search, filters, and view toggle */}
      {selectedVendorId && (
        <Toolbar
          searchQuery={searchQuery}
          filterMissingImage={filterMissingImage}
          viewMode={viewMode}
          missingCount={missingCount}
          filteredCount={filteredStyles.length}
          totalCount={styles.length}
          imageCount={imageCount}
          onSearchChange={setSearchQuery}
          onToggleMissing={() => setFilterMissingImage((v) => !v)}
          onViewModeChange={setViewMode}
        />
      )}

      {/* Hidden file input for image uploads */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        aria-hidden="true"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleImageUpload(file);
          if (fileInputRef.current) fileInputRef.current.value = "";
        }}
      />

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-8 h-8 text-sh-blue animate-spin" />
        </div>
      )}

      {/* Empty state */}
      {showEmpty && (
        <div className="text-center py-16 text-sh-gray">
          <p>{searchQuery ? "No styles match your search." : "No styles found."}</p>
        </div>
      )}

      {/* Grid view */}
      {showGrid && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
            {pagedStyles.map((s) => (
              <GridCard
                key={s.id}
                style={s}
                isEditingName={editingNameId === s.id}
                editingNameValue={editingNameValue}
                isSavingName={savingNameId === s.id}
                isUploadingImage={uploadingImageId === s.id}
                onOpenModal={() => setEditingStyleId(s.id)}
                onStartImageUpload={() => startImageUpload(s.id)}
                onStartNameEdit={() => startNameEdit(s)}
                onNameChange={setEditingNameValue}
                onNameSave={handleInlineNameSave}
                onNameCancel={() => setEditingNameId(null)}
              />
            ))}
          </div>
          <PaginationControls
            totalCount={filteredStyles.length}
            currentPage={currentPage}
            onPageChange={setCurrentPage}
            rowsPerPage={CARDS_PER_PAGE}
          />
        </>
      )}

      {/* List view */}
      {showList && (
        <>
          <div className="border border-sh-gray/20 rounded-lg overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-sh-linen text-sh-gray text-xs uppercase tracking-wider">
                    <th className="text-left px-3 py-2.5 font-medium w-16">Image</th>
                    <th className="text-left px-3 py-2.5 font-medium">Style</th>
                    <th className="text-left px-3 py-2.5 font-medium">Name</th>
                    <th className="text-left px-3 py-2.5 font-medium">Dimensions</th>
                    <th className="text-left px-3 py-2.5 font-medium">Finish</th>
                    <th className="text-center px-3 py-2.5 font-medium w-20">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedStyles.map((s) => (
                    <ListRow
                      key={s.id}
                      style={s}
                      isEditingName={editingNameId === s.id}
                      editingNameValue={editingNameValue}
                      isSavingName={savingNameId === s.id}
                      isUploadingImage={uploadingImageId === s.id}
                      onOpenModal={() => setEditingStyleId(s.id)}
                      onStartImageUpload={() => startImageUpload(s.id)}
                      onStartNameEdit={() => startNameEdit(s)}
                      onNameChange={setEditingNameValue}
                      onNameSave={handleInlineNameSave}
                      onNameCancel={() => setEditingNameId(null)}
                    />
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

      {/* Full edit modal */}
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
