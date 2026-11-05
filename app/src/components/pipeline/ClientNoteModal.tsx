// /app/src/components/pipeline/ClientNoteModal.tsx

import { useState } from "react";
import axios from "axios";
import { Dialog, DialogBackdrop, DialogPanel } from "@headlessui/react";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import { CLIENT_NOTE_SOURCE } from "@/lib/interactionSources";
import { getErrorMessage } from "@/lib/toastError";

export function ClientNoteModal({
  customerId,
  salesOrderId,
  title,
  staysOnQuote = false,
  onClose,
  onSaved,
}: Readonly<{
  customerId?: number;
  salesOrderId?: number;
  title: string;
  staysOnQuote?: boolean;
  onClose: () => void;
  onSaved: () => void;
}>) {
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await axios.post("/api/sales/interactions", {
        customerId,
        salesOrderId,
        source: CLIENT_NOTE_SOURCE,
        notes: note,
      });
      toast.success("Note saved.");
      onSaved();
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to save note."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onClose={onClose} className="relative z-50">
      <DialogBackdrop className="fixed inset-0 bg-black/40" />
      <div className="fixed inset-0 flex items-end sm:items-center justify-center p-4">
        <DialogPanel className="bg-white rounded-xl shadow-2xl w-full max-w-md p-6 space-y-5">
          <div>
            <h2 className="text-lg font-semibold text-brand-black font-serif">Add Note</h2>
            <p className="text-sm text-brand-gray mt-0.5">{title}</p>
          </div>
          <div>
            <label
              htmlFor="client-note-text"
              className="block text-xs text-brand-gray uppercase tracking-wide mb-2"
            >
              Note
            </label>
            <textarea
              id="client-note-text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={5}
              placeholder="Summer home at the shore, prefers warm neutrals..."
              className="w-full border border-brand-gray/30 rounded-lg px-3 py-2 text-sm text-brand-black resize-none focus:outline-none focus:ring-1 focus:ring-brand-blue"
            />
            <p className="text-xs text-brand-gray mt-1.5">
              {staysOnQuote
                ? "Stays on this quote. Doesn't count as contact."
                : "Stays with this client and shows on all their quotes. Doesn't count as contact."}
            </p>
          </div>
          <div className="flex gap-3 pt-1">
            <Button
              onClick={handleSave}
              disabled={saving || !note.trim()}
              className="flex-1 min-h-[44px]"
            >
              {saving ? "Saving..." : "Save Note"}
            </Button>
            <button
              type="button"
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
