// /app/src/components/buyer-drafts/BarcodeLookupModal.tsx
//
// Slice 4.5 — quick re-order from existing catalog by barcode/UPC.
//
// Workflow: buyer enters or scans a UPC. We look it up via the
// `/api/admin/buyer-drafts/products/lookup-by-barcode` endpoint; if a
// matching Product exists, we show a preview (vendor / name / cost /
// retail / discontinued flag). "Add to drafts" POSTs the pre-filled
// body to `/api/admin/buyer-drafts/items` and closes the modal.
//
// For iPad scan workflows the input gets focus on open + uses
// `inputMode="search"` so hardware scanners that emit Enter at the end
// submit the form directly.

import { useEffect, useRef, useState } from "react";
import axios from "axios";
import { Dialog, DialogPanel, DialogBackdrop, DialogTitle } from "@headlessui/react";
import { toast } from "react-toastify";
import { X, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";

interface ProductPreview {
  id: number;
  productNumber: string;
  name: string;
  vendorName: string;
  isActive: boolean;
  isDiscontinued: boolean;
  cost: string | null;
  retail: string | null;
}

interface SalesHistory {
  units: number;
  revenue: number;
  distinctOrders: number;
  windowMonths: number;
}

interface LookupResponse {
  product: ProductPreview;
  draftBody: Record<string, unknown>;
  /** Slice 6.12 — null when frame inference fails (no productNumber
   *  stem) so the UI can hide the badge rather than rendering zeros. */
  salesHistory: SalesHistory | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (draftId: number) => void;
}

export default function BarcodeLookupModal({ open, onClose, onCreated }: Readonly<Props>) {
  const [barcode, setBarcode] = useState("");
  const [preview, setPreview] = useState<LookupResponse | null>(null);
  const [looking, setLooking] = useState(false);
  const [adding, setAdding] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  // Slice 6.2 (2026-05-12) — qty input. Default 1; resets on each open.
  // Stored as string so the input can show empty mid-edit without
  // forcing 0; coerced to int (min 1) on submit.
  const [qty, setQty] = useState("1");
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset state when the modal opens; auto-focus the input for scanners.
  useEffect(() => {
    if (open) {
      setBarcode("");
      setPreview(null);
      setLookupError(null);
      setLooking(false);
      setAdding(false);
      setQty("1");
      // Defer focus until after the dialog renders.
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  async function handleLookup() {
    const trimmed = barcode.trim();
    if (!trimmed) return;
    setLooking(true);
    setLookupError(null);
    setPreview(null);
    try {
      const res = await axios.get<LookupResponse>(
        "/api/admin/buyer-drafts/products/lookup-by-barcode",
        { params: { barcode: trimmed } },
      );
      setPreview(res.data);
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        setLookupError(`No product found for barcode "${trimmed}"`);
      } else {
        setLookupError(getErrorMessage(err, "Lookup failed"));
      }
    } finally {
      setLooking(false);
    }
  }

  async function handleAddToDrafts() {
    if (!preview) return;
    setAdding(true);
    try {
      // Slice 6.2 — fold the user-entered qty into the body. parseInt
      // falls back to 1 for empty/garbage; the backend's buildItemCreateData
      // also clamps to a sane default but enforcing here keeps the UX
      // predictable ("you typed 0, I'll use 1 instead of erroring").
      const parsed = Number.parseInt(qty, 10);
      const effectiveQty = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
      const body = { ...preview.draftBody, qty: effectiveQty };
      const res = await axios.post<{ item: { id: number } }>("/api/admin/buyer-drafts/items", body);
      toast.success(`Added ${effectiveQty} × "${preview.product.name}" from catalog`);
      onCreated(res.data.item.id);
      onClose();
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to create draft"));
    } finally {
      setAdding(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} className="relative z-[70]">
      <DialogBackdrop className="fixed inset-0 bg-black/50" />
      <div className="fixed inset-0 overflow-y-auto">
        <div className="flex min-h-full items-center justify-center p-4">
          <DialogPanel className="w-full max-w-lg bg-white rounded-2xl shadow-xl flex flex-col">
            {/* Header */}
            <div className="flex items-start justify-between px-6 py-4 border-b border-sh-stripe">
              <div>
                <DialogTitle as="h2" className="font-serif text-xl text-sh-navy">
                  Quick add by barcode
                </DialogTitle>
                <p className="text-xs text-sh-gray mt-1">
                  Scan or type a UPC to add an existing catalog item as a draft.
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="text-sh-gray hover:text-sh-navy"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Body */}
            <div className="px-6 py-4 space-y-4">
              <div>
                <label
                  htmlFor="barcode-input"
                  className="block text-sm font-semibold text-sh-navy mb-1"
                >
                  Barcode / UPC
                </label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-sh-gray" />
                  <input
                    ref={inputRef}
                    id="barcode-input"
                    type="text"
                    inputMode="search"
                    autoComplete="off"
                    value={barcode}
                    onChange={(e) => setBarcode(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void handleLookup();
                      }
                    }}
                    placeholder="Scan or type UPC, press Enter"
                    className="w-full pl-9 pr-3 py-3 border border-sh-stripe rounded text-base min-h-[44px]"
                  />
                </div>
                {lookupError && (
                  <p className="text-sm text-red-600 mt-2" role="alert">
                    {lookupError}
                  </p>
                )}
              </div>

              {/* Preview */}
              {preview && (
                <div className="border border-sh-stripe rounded-lg p-3 bg-sh-stripe/30">
                  <div className="text-xs uppercase text-sh-gray tracking-wide">
                    {preview.product.vendorName}
                  </div>
                  <div className="font-semibold text-sh-navy">{preview.product.name}</div>
                  <code className="text-xs text-sh-gray font-mono">
                    {preview.product.productNumber}
                  </code>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <div className="text-sh-gray">Cost</div>
                      <div className="font-semibold">{preview.product.cost ?? "—"}</div>
                    </div>
                    <div>
                      <div className="text-sh-gray">Retail</div>
                      <div className="font-semibold">{preview.product.retail ?? "—"}</div>
                    </div>
                  </div>
                  {preview.product.isDiscontinued && (
                    <div className="text-xs text-red-700 mt-2 font-semibold">
                      ⚠ Discontinued by vendor
                    </div>
                  )}
                  {!preview.product.isActive && !preview.product.isDiscontinued && (
                    <div className="text-xs text-sh-gold mt-2 font-semibold">⚠ Marked inactive</div>
                  )}
                  {/* Slice 6.12 — operational awareness: how did this
                      frame sell last year? Buyer's quantity decision
                      should be informed by data, not memory. */}
                  {preview.salesHistory && (
                    <div className="mt-3 pt-3 border-t border-sh-stripe">
                      <div className="text-xs uppercase text-sh-gray tracking-wide mb-1">
                        Last {preview.salesHistory.windowMonths} months · frame total
                      </div>
                      <div className="flex items-baseline gap-3 text-sm">
                        <div>
                          <span className="font-semibold text-sh-navy">
                            {preview.salesHistory.units}
                          </span>
                          <span className="text-sh-gray ml-1">units</span>
                        </div>
                        <div className="text-sh-gray">·</div>
                        <div>
                          <span className="font-semibold text-sh-navy">
                            {preview.salesHistory.revenue.toLocaleString("en-US", {
                              style: "currency",
                              currency: "USD",
                              maximumFractionDigits: 0,
                            })}
                          </span>
                        </div>
                        <div className="text-sh-gray">·</div>
                        <div className="text-xs text-sh-gray">
                          {preview.salesHistory.distinctOrders} order
                          {preview.salesHistory.distinctOrders === 1 ? "" : "s"}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-6 py-3 border-t border-sh-stripe flex items-center justify-end gap-2">
              {/* Slice 6.2 — qty input appears once a preview is shown
                  so the buyer can scan + bump qty + save in one flow,
                  rather than scan-save-edit-save. 44px tap target. */}
              {preview && (
                <div className="flex items-center gap-2 mr-auto">
                  <label htmlFor="barcode-qty" className="text-sm text-sh-navy font-semibold">
                    Qty
                  </label>
                  <input
                    id="barcode-qty"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    value={qty}
                    onChange={(e) => setQty(e.target.value)}
                    disabled={adding}
                    className="w-20 px-2 py-2 border border-sh-stripe rounded text-base min-h-[44px]"
                  />
                </div>
              )}
              <Button variant="secondary" onClick={onClose} className="min-h-[44px]">
                Cancel
              </Button>
              {preview ? (
                <Button onClick={handleAddToDrafts} disabled={adding} className="min-h-[44px]">
                  {adding ? "Adding…" : "Add to drafts"}
                </Button>
              ) : (
                <Button
                  onClick={handleLookup}
                  disabled={looking || !barcode.trim()}
                  className="min-h-[44px]"
                >
                  {looking ? "Looking up…" : "Look up"}
                </Button>
              )}
            </div>
          </DialogPanel>
        </div>
      </div>
    </Dialog>
  );
}
