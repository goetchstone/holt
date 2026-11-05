// /app/src/components/customer/CustomerNotesPanel.tsx
//
// The customer page's view of what salespeople keep on a client: Client Info, an
// add-note box, and every note and logged follow-up across all their quotes.

import { useEffect, useState } from "react";
import axios from "axios";
import Link from "next/link";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import { ClientInfoModal } from "@/components/pipeline/ClientInfoModal";
import { ClientInfoSummary } from "@/components/pipeline/ClientInfoSummary";
import { EMPTY_CLIENT_PROFILE, hasClientInfo, type ClientProfileView } from "@/lib/clientProfile";
import {
  CLIENT_NOTE_SOURCE,
  INTERACTION_SOURCE_LABELS,
  type InteractionSource,
} from "@/lib/interactionSources";
import { getErrorMessage } from "@/lib/toastError";

interface ClientNote {
  id: number;
  source: string;
  notes: string | null;
  startedAt: string;
  createdBy: string | null;
  staffMember: { displayName: string } | null;
  salesOrder: { id: number; orderno: string } | null;
}

export function CustomerNotesPanel({
  customerId,
  customerName,
  canEdit,
}: Readonly<{ customerId: number; customerName: string; canEdit: boolean }>) {
  const [profile, setProfile] = useState<ClientProfileView>(EMPTY_CLIENT_PROFILE);
  const [loadFailed, setLoadFailed] = useState(false);
  const [history, setHistory] = useState<ClientNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [noteText, setNoteText] = useState("");
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let isCurrent = true;
    axios
      .get(`/api/customers/${customerId}/client-profile`)
      .then((res) => {
        if (!isCurrent) return;
        setProfile(res.data.profile);
        setHistory(res.data.history);
      })
      .catch((err) => {
        if (!isCurrent) return;
        setLoadFailed(true);
        toast.error(getErrorMessage(err, "Failed to load client notes."));
      })
      .finally(() => {
        if (isCurrent) setLoading(false);
      });
    return () => {
      isCurrent = false;
    };
  }, [customerId, refreshKey]);

  function reload() {
    setRefreshKey((key) => key + 1);
  }

  async function handleAddNote() {
    setSaving(true);
    try {
      await axios.post("/api/sales/interactions", {
        customerId,
        source: CLIENT_NOTE_SOURCE,
        notes: noteText,
      });
      setNoteText("");
      reload();
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to save note."));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="text-brand-gray">Loading notes...</p>;
  if (loadFailed) return <p className="text-brand-gray">Unable to load notes for this client.</p>;

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-xl font-semibold">Client Info</h2>
          {canEdit && (
            <Button onClick={() => setEditing(true)} className="min-h-[44px]">
              {hasClientInfo(profile) ? "Edit" : "Add client info"}
            </Button>
          )}
        </div>
        {hasClientInfo(profile) ? (
          <ClientInfoSummary profile={profile} />
        ) : (
          <p className="text-sm text-brand-gray">Nothing on file yet.</p>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-xl font-semibold">Notes</h2>
        {canEdit && (
          <>
            <label htmlFor="client-note" className="sr-only">
              Add a note about this client
            </label>
            <textarea
              id="client-note"
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              rows={3}
              placeholder="Summer home, prefers warm neutrals..."
              className="w-full border border-brand-gray/30 rounded-lg px-3 py-2 text-sm text-brand-black resize-none focus:outline-none focus:ring-1 focus:ring-brand-blue"
            />
            <Button
              onClick={handleAddNote}
              disabled={saving || !noteText.trim()}
              className="min-h-[44px]"
            >
              {saving ? "Saving..." : "Add Note"}
            </Button>
          </>
        )}

        {history.length === 0 ? (
          <p className="text-sm text-brand-gray pt-2">No notes or follow-ups yet.</p>
        ) : (
          <ul className="divide-y divide-brand-gray/10 pt-2">
            {history.map((entry) => (
              <li key={entry.id} className="py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2 text-xs text-brand-gray">
                  <span>{new Date(entry.startedAt).toLocaleDateString("en-US")}</span>
                  <span className="px-1.5 py-0.5 rounded bg-brand-linen font-medium">
                    {INTERACTION_SOURCE_LABELS[entry.source as InteractionSource] ?? entry.source}
                  </span>
                  <span>{entry.staffMember?.displayName}</span>
                  {entry.salesOrder && (
                    <Link
                      href={`/app/sales/orders/${entry.salesOrder.id}`}
                      className="text-brand-blue hover:underline"
                    >
                      {entry.salesOrder.orderno}
                    </Link>
                  )}
                </div>
                {entry.notes && (
                  <p className="mt-1 text-brand-black whitespace-pre-wrap break-words">
                    {entry.notes}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {editing && (
        <ClientInfoModal
          customerId={customerId}
          customerName={customerName}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            reload();
          }}
        />
      )}
    </div>
  );
}
