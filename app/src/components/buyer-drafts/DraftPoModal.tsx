// /app/src/components/buyer-drafts/DraftPoModal.tsx
//
// Create / edit a draft PO. Replaces the prior `prompt()`-based flow
// (which only collected a vendor name string) with a real form so the
// buyer can pick the actual Vendor record (FK), set ETA, link a Buy,
// drop a reference number, and add notes — all in one place.
//
// Used in two modes:
//   - create:   editingPo == null  → POST /api/admin/buyer-drafts/pos
//   - edit:     editingPo != null  → PATCH /api/admin/buyer-drafts/pos/[id]
//
// Body shape matches `lib/buyerDraftRequestBody.ts` (BuyerDraftPoCreateBody /
// BuyerDraftPoUpdateBody). Vendor is required for create; everything else
// optional. Edit accepts sparse patches.

import { useEffect, useState } from "react";
import axios from "axios";
import { Dialog, DialogPanel, DialogBackdrop, DialogTitle } from "@headlessui/react";
import { toast } from "react-toastify";
import { X, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";
import { normalizeShipMonth, formatShipMonthForInput } from "@/lib/buyPerformanceWindow";

interface VendorOption {
  id: number;
  name: string;
  code: string | null;
}
interface StoreLocationOption {
  id: number;
  name: string;
  code: string;
}
interface BuyOption {
  id: number;
  name: string;
  year: number | null;
  status: string;
}

export interface EditingPo {
  id: number;
  vendorId: number | null;
  vendorName: string;
  referenceNumber: string | null;
  expectedShipMonth: string | null;
  storeLocationId: number | null;
  buyId: number | null;
  status: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  vendors: readonly VendorOption[];
  storeLocations: readonly StoreLocationOption[];
  buys: readonly BuyOption[];
  editingPo: EditingPo | null;
}

// PO lifecycle per buyer-drafts runbook. Manual workflow: the buyer
// flips this as the PO moves through the real-world steps. There's no
// auto-driver today (slice 5 auto-link only flips ITEM status, not PO).
// Keep this list in sync with `VALID_PO_STATUSES` in
// `lib/buyerDraftRequestBody.ts`.
const PO_STATUSES = ["DRAFT", "READY", "EXPORTED", "FULFILLED", "CANCELLED"] as const;
type PoStatus = (typeof PO_STATUSES)[number];

interface FormState {
  vendorId: string; // empty string = unselected
  referenceNumber: string;
  expectedShipMonth: string;
  storeLocationId: string;
  buyId: string;
  status: PoStatus;
  notes: string;
}

const EMPTY_FORM: FormState = {
  vendorId: "",
  referenceNumber: "",
  expectedShipMonth: "",
  storeLocationId: "",
  buyId: "",
  status: "DRAFT",
  notes: "",
};

export default function DraftPoModal({
  open,
  onClose,
  onSaved,
  vendors,
  storeLocations,
  buys,
  editingPo,
}: Readonly<Props>) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Hydrate form when modal opens or the editing target changes.
  useEffect(() => {
    if (!open) return;
    if (editingPo) {
      setForm({
        vendorId: editingPo.vendorId == null ? "" : String(editingPo.vendorId),
        referenceNumber: editingPo.referenceNumber ?? "",
        // After DateTime promotion the API returns an ISO datetime
        // string for this field. The `<input type="month">` needs
        // `YYYY-MM`, so format on the way in.
        expectedShipMonth: formatShipMonthForInput(editingPo.expectedShipMonth),
        storeLocationId: editingPo.storeLocationId == null ? "" : String(editingPo.storeLocationId),
        buyId: editingPo.buyId == null ? "" : String(editingPo.buyId),
        status: isValidPoStatus(editingPo.status) ? editingPo.status : "DRAFT",
        notes: "",
      });
    } else {
      setForm(EMPTY_FORM);
    }
  }, [open, editingPo]);

  const isEdit = editingPo !== null;
  const vendorIdNum = form.vendorId === "" ? null : Number(form.vendorId);
  const selectedVendor = vendorIdNum === null ? null : vendors.find((v) => v.id === vendorIdNum);

  const canSave = selectedVendor !== null;
  const submitLabel = computeSubmitLabel(saving, isEdit);

  async function handleSubmit() {
    if (!selectedVendor) {
      toast.error("Pick a vendor");
      return;
    }
    setSaving(true);
    try {
      // Normalize the ETA on save. iPad Safari (and any future manual-
      // entry path) sometimes emits MM-YYYY; the parser accepts both
      // but the DB should always hold canonical YYYY-MM so downstream
      // consumers (workbook export, performance report) don't have to
      // care. Failure log 2026-05-13. Falls back to the raw trimmed
      // value when parsing fails so we don't silently drop free-text
      // legacy data the buyer typed deliberately.
      const trimmedShipMonth = form.expectedShipMonth.trim();
      const normalizedShipMonth =
        trimmedShipMonth === "" ? null : (normalizeShipMonth(trimmedShipMonth) ?? trimmedShipMonth);
      // Only send status on edit. On create the default DRAFT is
      // applied by `lib/buyerDraftRequestBody.ts:buildPoCreateData`
      // and explicitly setting it would be redundant.
      const body: Record<string, unknown> = {
        vendorId: selectedVendor.id,
        vendorName: selectedVendor.name,
        referenceNumber: form.referenceNumber.trim() || null,
        expectedShipMonth: normalizedShipMonth,
        storeLocationId: form.storeLocationId === "" ? null : Number(form.storeLocationId),
        buyId: form.buyId === "" ? null : Number(form.buyId),
        notes: form.notes.trim() || null,
      };
      if (isEdit) body.status = form.status;
      if (isEdit && editingPo) {
        await axios.patch(`/api/admin/buyer-drafts/pos/${editingPo.id}`, body);
        toast.success("PO updated");
      } else {
        await axios.post("/api/admin/buyer-drafts/pos", body);
        toast.success("PO created");
      }
      onSaved();
      onClose();
    } catch (err) {
      toast.error(getErrorMessage(err, isEdit ? "Failed to update PO" : "Failed to create PO"));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!editingPo) return;
    if (
      !globalThis.confirm(
        `Delete PO "${editingPo.referenceNumber ?? editingPo.id}"? Linked items become unassigned.`,
      )
    )
      return;
    setDeleting(true);
    try {
      await axios.delete(`/api/admin/buyer-drafts/pos/${editingPo.id}`);
      toast.success("PO deleted");
      onSaved();
      onClose();
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to delete PO"));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} className="relative z-[70]">
      <DialogBackdrop className="fixed inset-0 bg-black/50" />
      <div className="fixed inset-0 overflow-y-auto">
        <div className="flex min-h-full items-center justify-center p-4">
          <DialogPanel className="w-full max-w-xl bg-white rounded-2xl shadow-xl flex flex-col">
            {/* Header */}
            <div className="flex items-start justify-between px-6 py-4 border-b border-sh-stripe">
              <DialogTitle as="h2" className="font-serif text-xl text-sh-navy">
                {isEdit ? "Edit draft PO" : "New draft PO"}
              </DialogTitle>
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
              {/* Vendor */}
              <div>
                <label
                  htmlFor="po-vendor"
                  className="block text-sm font-semibold text-sh-navy mb-1"
                >
                  Supplier <span className="text-red-600">*</span>
                </label>
                <select
                  id="po-vendor"
                  value={form.vendorId}
                  onChange={(e) => setForm((f) => ({ ...f, vendorId: e.target.value }))}
                  className="w-full px-3 py-2 border border-sh-stripe rounded text-base"
                >
                  <option value="">Select supplier…</option>
                  {vendors.map((v) => (
                    <option key={v.id} value={String(v.id)}>
                      {v.name}
                      {v.code ? ` (${v.code})` : ""}
                    </option>
                  ))}
                </select>
              </div>

              {/* Reference number */}
              <div>
                <label htmlFor="po-ref" className="block text-sm font-semibold text-sh-navy mb-1">
                  Vendor reference number
                </label>
                <input
                  id="po-ref"
                  type="text"
                  value={form.referenceNumber}
                  onChange={(e) => setForm((f) => ({ ...f, referenceNumber: e.target.value }))}
                  placeholder="e.g. SH-FALL26-WH-1"
                  className="w-full px-3 py-2 border border-sh-stripe rounded text-base"
                />
              </div>

              {/* ETA + store location side-by-side */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="po-eta" className="block text-sm font-semibold text-sh-navy mb-1">
                    ETA (year-month)
                  </label>
                  <input
                    id="po-eta"
                    type="month"
                    value={form.expectedShipMonth}
                    onChange={(e) => setForm((f) => ({ ...f, expectedShipMonth: e.target.value }))}
                    className="w-full px-3 py-2 border border-sh-stripe rounded text-base"
                  />
                </div>
                <div>
                  <label
                    htmlFor="po-store"
                    className="block text-sm font-semibold text-sh-navy mb-1"
                  >
                    Destination store
                  </label>
                  <select
                    id="po-store"
                    value={form.storeLocationId}
                    onChange={(e) => setForm((f) => ({ ...f, storeLocationId: e.target.value }))}
                    className="w-full px-3 py-2 border border-sh-stripe rounded text-base"
                  >
                    <option value="">— None —</option>
                    {storeLocations.map((s) => (
                      <option key={s.id} value={String(s.id)}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Buy + Status side-by-side on edit; Buy alone on create */}
              <div className={isEdit ? "grid grid-cols-1 sm:grid-cols-2 gap-3" : ""}>
                <div>
                  <label htmlFor="po-buy" className="block text-sm font-semibold text-sh-navy mb-1">
                    Buy (optional)
                  </label>
                  <select
                    id="po-buy"
                    value={form.buyId}
                    onChange={(e) => setForm((f) => ({ ...f, buyId: e.target.value }))}
                    className="w-full px-3 py-2 border border-sh-stripe rounded text-base"
                  >
                    <option value="">— Unassigned —</option>
                    {buys.map((b) => (
                      <option key={b.id} value={String(b.id)}>
                        {b.name}
                        {b.year ? ` (${b.year})` : ""} — {b.status}
                      </option>
                    ))}
                  </select>
                </div>
                {/* Status only on edit. On create the default is DRAFT
                    and there's no realistic reason to set anything else
                    at the moment the PO is being typed in. */}
                {isEdit && (
                  <div>
                    <label
                      htmlFor="po-status"
                      className="block text-sm font-semibold text-sh-navy mb-1"
                    >
                      Status
                    </label>
                    <select
                      id="po-status"
                      value={form.status}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, status: e.target.value as PoStatus }))
                      }
                      className="w-full px-3 py-2 border border-sh-stripe rounded text-base"
                    >
                      {PO_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              {/* Notes — only on edit, since create rarely needs them */}
              {isEdit && (
                <div>
                  <label
                    htmlFor="po-notes"
                    className="block text-sm font-semibold text-sh-navy mb-1"
                  >
                    Notes
                  </label>
                  <textarea
                    id="po-notes"
                    value={form.notes}
                    onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                    rows={3}
                    className="w-full px-3 py-2 border border-sh-stripe rounded text-base resize-y"
                  />
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-6 py-3 border-t border-sh-stripe flex items-center justify-between gap-2">
              <div>
                {isEdit && (
                  <Button
                    variant="secondary"
                    onClick={handleDelete}
                    disabled={deleting || saving}
                    className="min-h-[44px] text-red-600 hover:bg-red-50"
                  >
                    <Trash2 className="h-4 w-4 mr-1" />
                    {deleting ? "Deleting…" : "Delete PO"}
                  </Button>
                )}
              </div>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  onClick={onClose}
                  disabled={saving || deleting}
                  className="min-h-[44px]"
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleSubmit}
                  disabled={!canSave || saving || deleting}
                  className="min-h-[44px]"
                >
                  {submitLabel}
                </Button>
              </div>
            </div>
          </DialogPanel>
        </div>
      </div>
    </Dialog>
  );
}

function computeSubmitLabel(saving: boolean, isEdit: boolean): string {
  if (saving) return "Saving…";
  return isEdit ? "Save changes" : "Create PO";
}

// Type-narrow the editingPo.status string (which is typed as `string`
// in the EditingPo interface to keep the import light) into the PoStatus
// union before we hand it to a typed `<select>`. Falling back to DRAFT
// keeps the modal usable even if a future enum value drifts in.
function isValidPoStatus(s: string): s is PoStatus {
  return (PO_STATUSES as readonly string[]).includes(s);
}
