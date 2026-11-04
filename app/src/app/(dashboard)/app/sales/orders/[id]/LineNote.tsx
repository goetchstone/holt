"use client";

// GAP-07: staff's note on an order line, on the order screen -- "legs in
// walnut", "customer to confirm fabric". Printed under the line on the
// invoice, and found by the orders search. Saved through line-items/
// [lineItemId] PUT, action "note"; lib/sales/lineNotesShared.ts decides what a
// note may be, on both sides.

import { useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { getErrorMessage } from "@/lib/toastError";
import { LINE_NOTE_MAX } from "@/lib/sales/lineNotesShared";

interface Props {
  orderId: number;
  line: { id: number; name: string; notes: string | null };
  editable: boolean;
  onChanged: () => void;
}

export function LineNote({ orderId, line, editable, onChanged }: Readonly<Props>) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(line.notes ?? "");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await axios.put(
        `/api/sales/orders/${encodeURIComponent(String(orderId))}/line-items/${line.id}`,
        { action: "note", notes: draft.trim() || null },
      );
      toast.success(draft.trim() ? "Note saved." : "Note removed.");
      setEditing(false);
      onChanged();
    } catch (err) {
      toast.error(getErrorMessage(err, "Couldn't save the note."));
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div className="mt-1 text-xs">
        <textarea
          value={draft}
          maxLength={LINE_NOTE_MAX}
          rows={2}
          onChange={(e) => setDraft(e.target.value)}
          aria-label={`Note on ${line.name}`}
          className="w-full rounded border border-brand-gray/30 px-2 py-1 text-xs"
        />
        <div className="mt-1 flex gap-2">
          <button
            type="button"
            disabled={saving}
            onClick={save}
            className="rounded border border-brand-blue px-1.5 py-0.5 text-brand-blue disabled:opacity-40"
          >
            Save note
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              setDraft(line.notes ?? "");
              setEditing(false);
            }}
            className="px-1 text-brand-gray"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-1 flex flex-wrap items-start gap-1 text-xs">
      {line.notes && <p className="whitespace-pre-line italic text-brand-black">{line.notes}</p>}
      {editable && (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-brand-blue underline"
        >
          {line.notes ? "Edit note" : "Add note"}
        </button>
      )}
    </div>
  );
}
