// /app/src/components/buyer-drafts/VendorStylePickerModal.tsx
//
// Modal for the "Pick from catalog" affordance in the draft-item wizard.
// Lists VendorStyles for the currently-selected vendor, lets the buyer
// search by part number / name, and on click returns the full payload
// the wizard needs to pre-fill its fields (partNumber, productName,
// vendorStyleId, cost, retail, dimensions, taxonomy).
//
// Lighter-weight than the full PriceConfigurator integration — gives the
// buyer a head-start from catalog data without forcing them through the
// configurator's grade/fabric/options flow. The structured fields they
// haven't filled yet (Grade / Fabric / Finish / Cleaning Code / Options)
// stay empty for the buyer to fill on the Description step.

import { useState, useEffect, useMemo } from "react";
import axios from "axios";
import { Dialog, DialogPanel, DialogBackdrop, DialogTitle } from "@headlessui/react";
import { Search, Loader2, X, Package, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";
import { toast } from "react-toastify";

// ─── Lookup shape — mirrors what the API returns ───────────────────────

export interface VendorStyleSummary {
  id: number;
  styleNumber: string;
  name: string;
  description: string | null;
  baseCost: string | null;
  baseRetail: string | null;
  length: number | null;
  width: number | null;
  depth: number | null;
  height: number | null;
  imageUrl: string | null;
  isDiscontinued: boolean;
  department: { id: number; name: string } | null;
  category: { id: number; name: string } | null;
  type: { id: number; name: string } | null;
}

// ─── Picked payload — what the wizard receives back ───────────────────
//
// Same shape as ItemFormState fields the wizard already has. Caller
// applies via `setField` for each key.

export interface VendorStylePicked {
  vendorStyleId: number;
  partNumber: string; // styleNumber
  productName: string; // name
  cost: string; // baseCost as string (form-state convention)
  retail: string; // baseRetail as string
  productWidth: string;
  productLength: string;
  productHeight: string;
  departmentId: number | null;
  categoryId: number | null;
  typeId: number | null;
}

interface Props {
  open: boolean;
  vendorId: number | null;
  vendorName: string;
  onClose: () => void;
  onPick: (picked: VendorStylePicked) => void;
}

export default function VendorStylePickerModal({
  open,
  vendorId,
  vendorName,
  onClose,
  onPick,
}: Readonly<Props>) {
  const [styles, setStyles] = useState<VendorStyleSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");

  // Load when modal opens or vendor changes.
  useEffect(() => {
    if (!open || vendorId === null) {
      setStyles([]);
      return;
    }
    setLoading(true);
    axios
      .get<{ styles: VendorStyleSummary[] }>(
        `/api/admin/buyer-drafts/vendor-styles?vendorId=${vendorId}`,
      )
      .then((res) => setStyles(res.data.styles ?? []))
      .catch((err) => toast.error(getErrorMessage(err, "Failed to load vendor styles")))
      .finally(() => setLoading(false));
  }, [open, vendorId]);

  // Client-side filter on top of the loaded list — fast for batches of 500.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return styles;
    return styles.filter((s) => {
      const haystack = `${s.styleNumber} ${s.name} ${s.department?.name ?? ""} ${
        s.category?.name ?? ""
      }`.toLowerCase();
      return haystack.includes(q);
    });
  }, [search, styles]);

  const handlePick = (style: VendorStyleSummary) => {
    onPick({
      vendorStyleId: style.id,
      partNumber: style.styleNumber,
      productName: style.name,
      cost: style.baseCost ?? "",
      retail: style.baseRetail ?? "",
      productWidth: numToInputString(style.width),
      productLength: pickDepthOrLength(style.depth, style.length),
      productHeight: numToInputString(style.height),
      departmentId: style.department?.id ?? null,
      categoryId: style.category?.id ?? null,
      typeId: style.type?.id ?? null,
    });
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} className="relative z-[60]">
      <DialogBackdrop className="fixed inset-0 bg-black/50" />
      <div className="fixed inset-0 overflow-y-auto">
        <div className="flex min-h-full items-center justify-center p-4">
          <DialogPanel className="w-full max-w-3xl bg-white rounded-2xl shadow-xl flex flex-col max-h-[85vh]">
            {/* Header */}
            <div className="flex items-start justify-between px-6 py-4 border-b border-sh-stripe">
              <div>
                <DialogTitle as="h2" className="font-serif text-xl text-sh-navy">
                  Pick from catalog
                </DialogTitle>
                <p className="text-xs text-sh-gray mt-1">
                  {vendorName ? `${vendorName} — ` : ""}
                  click a style to pre-fill the wizard&apos;s identity, pricing, and dimension
                  fields. You can still edit before saving.
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close picker"
                className="text-sh-gray hover:text-sh-navy"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Search */}
            <div className="px-6 py-3 border-b border-sh-stripe">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-sh-gray" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by part number, name, dept, or category…"
                  className="w-full pl-9 pr-3 py-2 border border-sh-stripe rounded text-base"
                  aria-label="Filter catalog"
                />
              </div>
            </div>

            {/* Results */}
            <div className="flex-1 overflow-y-auto">
              <PickerResults
                vendorId={vendorId}
                vendorName={vendorName}
                loading={loading}
                styles={styles}
                filtered={filtered}
                onPick={handlePick}
              />
            </div>

            {/* Footer */}
            <div className="px-6 py-3 border-t border-sh-stripe text-xs text-sh-gray flex items-center justify-between">
              <span>
                {filtered.length} of {styles.length} style{styles.length === 1 ? "" : "s"} shown
              </span>
              <Button variant="secondary" onClick={onClose} className="min-h-[36px]">
                Cancel
              </Button>
            </div>
          </DialogPanel>
        </div>
      </div>
    </Dialog>
  );
}

function formatMoney(value: string | number): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

// ─── Helpers (extracted to keep the main JSX flat) ────────────────────

/**
 * Convert a possibly-null number to the form-state's string convention.
 * Returns "" when the source is null (ItemFormState dimensions are all
 * `string`, with empty meaning "not set").
 */
function numToInputString(value: number | null): string {
  return value === null ? "" : String(value);
}

/**
 * Pick the best dimension for the productLength slot. VendorStyle has
 * both `depth` and `length`; depth wins when present, length is the
 * fallback. Returns "" when neither is set.
 */
function pickDepthOrLength(depth: number | null, length: number | null): string {
  if (depth !== null) return String(depth);
  if (length !== null) return String(length);
  return "";
}

interface PickerResultsProps {
  vendorId: number | null;
  vendorName: string;
  loading: boolean;
  styles: VendorStyleSummary[];
  filtered: VendorStyleSummary[];
  onPick: (style: VendorStyleSummary) => void;
}

function PickerResults({
  vendorId,
  vendorName,
  loading,
  styles,
  filtered,
  onPick,
}: Readonly<PickerResultsProps>) {
  if (vendorId === null) {
    return (
      <div className="p-8 text-center text-sh-gray text-sm">
        Select a vendor on the previous step before opening the catalog.
      </div>
    );
  }
  if (loading) {
    return (
      <div className="p-12 flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-sh-gold" />
      </div>
    );
  }
  if (filtered.length === 0) {
    const message =
      styles.length === 0
        ? `No vendor styles found for ${vendorName}.`
        : "No styles match the search.";
    return <div className="p-8 text-center text-sh-gray text-sm">{message}</div>;
  }
  return (
    <ul className="divide-y divide-sh-stripe">
      {filtered.map((style) => (
        <li key={style.id}>
          <PickerRow style={style} onPick={onPick} />
        </li>
      ))}
    </ul>
  );
}

function PickerRow({
  style,
  onPick,
}: Readonly<{ style: VendorStyleSummary; onPick: (s: VendorStyleSummary) => void }>) {
  const dimSummary = formatDimSummary(style);
  return (
    <button
      type="button"
      onClick={() => onPick(style)}
      className="w-full text-left px-6 py-3 hover:bg-sh-stripe/40 flex items-start gap-3"
    >
      {style.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={style.imageUrl}
          alt=""
          className="w-16 h-16 object-contain bg-sh-linen rounded flex-shrink-0"
        />
      ) : (
        <div className="w-16 h-16 bg-sh-stripe rounded flex items-center justify-center flex-shrink-0">
          <Package className="h-6 w-6 text-sh-gray" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <code className="font-mono font-semibold text-sh-navy">{style.styleNumber}</code>
          {style.isDiscontinued && (
            <span className="inline-flex items-center gap-1 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-0.5">
              <AlertTriangle className="h-3 w-3" /> Discontinued
            </span>
          )}
        </div>
        <div className="text-sm text-sh-navy">{style.name}</div>
        <div className="text-xs text-sh-gray mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
          {style.department?.name && <span>Dept: {style.department.name}</span>}
          {style.category?.name && <span>Cat: {style.category.name}</span>}
          {style.baseCost && <span>Cost: ${formatMoney(style.baseCost)}</span>}
          {style.baseRetail && <span>Retail: ${formatMoney(style.baseRetail)}</span>}
          {dimSummary && <span>{dimSummary}</span>}
        </div>
      </div>
    </button>
  );
}

function formatDimSummary(style: VendorStyleSummary): string | null {
  const dims = [style.width, style.depth, style.height].filter((d) => d !== null);
  if (dims.length === 0) return null;
  return `${dims.join(" × ")} in`;
}
