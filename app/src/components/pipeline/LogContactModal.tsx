// /app/src/components/pipeline/LogContactModal.tsx

import { useState } from "react";
import axios from "axios";
import { Dialog, DialogBackdrop, DialogPanel } from "@headlessui/react";
import { toast } from "react-toastify";
import { NextFollowUpPicker } from "@/components/pipeline/NextFollowUpPicker";
import { Button } from "@/components/ui/button";
import {
  CONTACT_SOURCES,
  INTERACTION_SOURCE_LABELS,
  type ContactSource,
} from "@/lib/interactionSources";
import { nextFollowUpAfterContact } from "@/lib/pipelineFollowUp";
import { getErrorMessage } from "@/lib/toastError";

/** Log reaching a client, about a quote or just the client (a call from My Clients). */
export function LogContactModal({
  customerId,
  salesOrderId,
  title,
  dateOnFile,
  canSchedule,
  today,
  onClose,
  onSaved,
}: Readonly<{
  customerId?: number;
  salesOrderId?: number;
  title: string;
  dateOnFile: string | null;
  canSchedule: boolean;
  today: string;
  onClose: () => void;
  onSaved: () => void;
}>) {
  const [source, setSource] = useState<ContactSource>("PHONE");
  const [notes, setNotes] = useState("");
  const [nextFollowUpDate, setNextFollowUpDate] = useState<string | null>(
    nextFollowUpAfterContact(dateOnFile, today),
  );
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await axios.post("/api/sales/interactions", {
        salesOrderId,
        customerId,
        source,
        notes: notes.trim() || undefined,
        // Sent only when it changes, so an old page can't erase a colleague's newer date.
        ...(canSchedule && nextFollowUpDate !== dateOnFile ? { nextFollowUpDate } : {}),
      });
      toast.success("Follow-up logged.");
      onSaved();
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to log follow-up."));
    } finally {
      setSaving(false);
    }
  }

  return (
    // Headless UI Dialog handles focus-trap, Escape, and click-outside
    // a11y natively. The backdrop is a non-interactive overlay; the
    // panel is the focusable dialog content.
    <Dialog open onClose={onClose} className="relative z-50">
      <DialogBackdrop className="fixed inset-0 bg-black/40" />
      <div className="fixed inset-0 flex items-end sm:items-center justify-center p-4">
        <DialogPanel className="bg-white rounded-xl shadow-2xl w-full max-w-md p-6 space-y-5">
          <div>
            <h2 className="text-lg font-semibold text-brand-black font-serif">Log Follow-Up</h2>
            <p className="text-sm text-brand-gray mt-0.5">{title}</p>
          </div>

          <div>
            <p className="text-xs text-brand-gray uppercase tracking-wide mb-2">
              How you reached them
            </p>
            <div className="grid grid-cols-4 gap-2">
              {CONTACT_SOURCES.map((s) => (
                <button
                  key={s}
                  onClick={() => setSource(s)}
                  className={`py-2 px-1 rounded-lg border text-xs font-semibold transition-colors min-h-[44px] ${
                    source === s
                      ? "bg-brand-blue text-white border-brand-blue"
                      : "border-brand-gray/30 text-brand-gray hover:border-brand-blue"
                  }`}
                >
                  {INTERACTION_SOURCE_LABELS[s]}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label
              htmlFor="follow-up-notes"
              className="block text-xs text-brand-gray uppercase tracking-wide mb-2"
            >
              Notes <span className="normal-case">(optional)</span>
            </label>
            <textarea
              id="follow-up-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Left voicemail about fabric selections..."
              className="w-full border border-brand-gray/30 rounded-lg px-3 py-2 text-sm text-brand-black resize-none focus:outline-none focus:ring-1 focus:ring-brand-blue"
            />
          </div>

          {canSchedule && (
            <NextFollowUpPicker
              value={nextFollowUpDate}
              today={today}
              onChange={setNextFollowUpDate}
            />
          )}

          <div className="flex gap-3 pt-1">
            <Button onClick={handleSave} disabled={saving} className="flex-1 min-h-[44px]">
              {saving ? "Saving..." : "Log Follow-Up"}
            </Button>
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-brand-gray/30 text-brand-gray text-sm min-h-[44px]"
            >
              Cancel
            </button>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
