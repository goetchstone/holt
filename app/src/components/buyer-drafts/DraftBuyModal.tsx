// /app/src/components/buyer-drafts/DraftBuyModal.tsx
//
// Create / edit / delete a Buy. Replaces the prior chained-prompt flow
// (4 prompts in a row for name / year / season / budget) with a real
// form so the buyer can also set kickoff date, notes, and status.
//
// Used in two modes:
//   - create:  editingBuy == null -> POST /api/admin/buyer-drafts/buys
//   - edit:    editingBuy != null -> PATCH /api/admin/buyer-drafts/buys/[id]
//
// Body shape matches lib/buyerDraftRequestBody.ts (BuyerDraftBuyCreateBody /
// BuyerDraftBuyUpdateBody). Edit accepts sparse patches. Delete detaches
// any linked POs (sets po.buyId = null) but never deletes them.

import { useEffect, useState } from "react";
import axios from "axios";
import { Dialog, DialogPanel, DialogBackdrop, DialogTitle } from "@headlessui/react";
import { toast } from "react-toastify";
import { X, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";

const BUY_STATUSES = ["PLANNING", "OPEN", "EXPORTED", "CLOSED"] as const;
type BuyStatus = (typeof BUY_STATUSES)[number];

const SEASONS = ["", "Spring", "Summer", "Fall", "Winter", "Holiday"] as const;

export interface EditingBuy {
  id: number;
  name: string;
  season: string | null;
  year: number | null;
  budget: string | null;
  status: BuyStatus;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  editingBuy: EditingBuy | null;
}

interface FormState {
  name: string;
  season: string;
  year: string;
  budget: string;
  status: BuyStatus;
  notes: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  season: "",
  year: "",
  budget: "",
  status: "PLANNING",
  notes: "",
};

export default function DraftBuyModal({ open, onClose, onSaved, editingBuy }: Readonly<Props>) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (editingBuy) {
      setForm({
        name: editingBuy.name,
        season: editingBuy.season ?? "",
        year: editingBuy.year == null ? "" : String(editingBuy.year),
        budget: editingBuy.budget == null ? "" : String(editingBuy.budget),
        status: editingBuy.status,
        notes: "",
      });
    } else {
      setForm(EMPTY_FORM);
    }
  }, [open, editingBuy]);

  const isEdit = editingBuy !== null;
  const canSave = form.name.trim().length > 0;
  const submitLabel = computeSubmitLabel(saving, isEdit);

  async function handleSubmit() {
    if (!canSave) {
      toast.error("Name is required");
      return;
    }
    setSaving(true);
    try {
      const yearNum = form.year.trim() === "" ? null : Number(form.year);
      const budgetNum = form.budget.trim() === "" ? null : Number(form.budget);
      const body = {
        name: form.name.trim(),
        season: form.season || null,
        year: yearNum !== null && Number.isFinite(yearNum) ? yearNum : null,
        budget: budgetNum !== null && Number.isFinite(budgetNum) ? budgetNum : null,
        status: form.status,
        notes: form.notes.trim() || null,
      };
      if (isEdit && editingBuy) {
        await axios.patch(`/api/admin/buyer-drafts/buys/${editingBuy.id}`, body);
        toast.success("Buy updated");
      } else {
        await axios.post("/api/admin/buyer-drafts/buys", body);
        toast.success(`Buy "${body.name}" created`);
      }
      onSaved();
      onClose();
    } catch (err) {
      toast.error(getErrorMessage(err, isEdit ? "Failed to update buy" : "Failed to create buy"));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!editingBuy) return;
    if (
      !globalThis.confirm(
        `Delete buy "${editingBuy.name}"? Linked POs are not deleted — they will become unassigned.`,
      )
    )
      return;
    setDeleting(true);
    try {
      await axios.delete(`/api/admin/buyer-drafts/buys/${editingBuy.id}`);
      toast.success("Buy deleted");
      onSaved();
      onClose();
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to delete buy"));
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
            <div className="flex items-start justify-between px-6 py-4 border-b border-sh-stripe">
              <DialogTitle as="h2" className="font-serif text-xl text-sh-navy">
                {isEdit ? "Edit buy" : "New buy"}
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

            <div className="px-6 py-4 space-y-4">
              {/* Name */}
              <div>
                <label htmlFor="buy-name" className="block text-sm font-semibold text-sh-navy mb-1">
                  Name <span className="text-red-600">*</span>
                </label>
                <input
                  id="buy-name"
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder='e.g. "Spring 2026", "Holiday 2025"'
                  className="w-full px-3 py-2 border border-sh-stripe rounded text-base"
                />
              </div>

              {/* Season + year */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="buy-season"
                    className="block text-sm font-semibold text-sh-navy mb-1"
                  >
                    Season
                  </label>
                  <select
                    id="buy-season"
                    value={form.season}
                    onChange={(e) => setForm((f) => ({ ...f, season: e.target.value }))}
                    className="w-full px-3 py-2 border border-sh-stripe rounded text-base"
                  >
                    {SEASONS.map((s) => (
                      <option key={s || "none"} value={s}>
                        {s || "— None —"}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label
                    htmlFor="buy-year"
                    className="block text-sm font-semibold text-sh-navy mb-1"
                  >
                    Year
                  </label>
                  <input
                    id="buy-year"
                    type="number"
                    inputMode="numeric"
                    value={form.year}
                    onChange={(e) => setForm((f) => ({ ...f, year: e.target.value }))}
                    placeholder="2026"
                    className="w-full px-3 py-2 border border-sh-stripe rounded text-base"
                  />
                </div>
              </div>

              {/* Budget + status */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="buy-budget"
                    className="block text-sm font-semibold text-sh-navy mb-1"
                  >
                    Budget ($)
                  </label>
                  <input
                    id="buy-budget"
                    type="number"
                    inputMode="decimal"
                    value={form.budget}
                    onChange={(e) => setForm((f) => ({ ...f, budget: e.target.value }))}
                    placeholder="50000"
                    className="w-full px-3 py-2 border border-sh-stripe rounded text-base"
                  />
                </div>
                <div>
                  <label
                    htmlFor="buy-status"
                    className="block text-sm font-semibold text-sh-navy mb-1"
                  >
                    Status
                  </label>
                  <select
                    id="buy-status"
                    value={form.status}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, status: e.target.value as BuyStatus }))
                    }
                    className="w-full px-3 py-2 border border-sh-stripe rounded text-base"
                  >
                    {BUY_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Notes */}
              {isEdit && (
                <div>
                  <label
                    htmlFor="buy-notes"
                    className="block text-sm font-semibold text-sh-navy mb-1"
                  >
                    Notes
                  </label>
                  <textarea
                    id="buy-notes"
                    value={form.notes}
                    onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                    rows={3}
                    className="w-full px-3 py-2 border border-sh-stripe rounded text-base resize-y"
                  />
                </div>
              )}
            </div>

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
                    {deleting ? "Deleting…" : "Delete buy"}
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
  return isEdit ? "Save changes" : "Create buy";
}
