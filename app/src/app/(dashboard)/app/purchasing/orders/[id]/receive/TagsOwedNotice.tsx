"use client";

// /app/src/app/(dashboard)/app/purchasing/orders/[id]/receive/TagsOwedNotice.tsx
//
// The tags a receipt left to print (receivedTagsShortNote), kept on the Receive
// PO screen until the receiver dismisses them, in the screen's own notice style
// (the drop-ship note's). They were a toast, which closed after three seconds as
// the receipt's own toasts appeared, and nothing else kept which products were
// short or by how many.

/** The notes so far, and a receipt's own: a receipt that owes nothing clears nothing. */
export function withTagsOwed(notes: readonly string[], note: string | null): string[] {
  return note ? [...notes, note] : [...notes];
}

export function TagsOwedNotice({
  notes,
  onDismiss,
}: Readonly<{ notes: readonly string[]; onDismiss: () => void }>) {
  if (notes.length === 0) return null;
  return (
    <div role="status" className="bg-white rounded-lg border border-brand-gray/20 shadow-sm p-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-brand-black">Tags still to print</h3>
        <button
          type="button"
          onClick={onDismiss}
          className="min-h-[44px] px-3 text-sm text-brand-gray underline"
        >
          Dismiss
        </button>
      </div>
      {notes.map((note, i) => (
        <p
          key={`${i}:${note}`}
          className="mt-2 rounded bg-brand-linen px-3 py-2 text-sm text-brand-black"
        >
          {note}
        </p>
      ))}
    </div>
  );
}
