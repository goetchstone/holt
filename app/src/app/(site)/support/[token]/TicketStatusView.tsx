// /app/src/app/(site)/support/[token]/TicketStatusView.tsx
//
// Public, no-login ticket status + reply view. Reads the public projection of a
// ticket (internal notes filtered out server-side) by its token and lets the
// visitor add a reply, which reopens a parked ticket back into the staff queue.

"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "react-toastify";
import { getErrorMessage } from "@/lib/toastError";
import { TICKET_STATUS_LABELS } from "@/lib/tickets/ticketContract";
import type { TicketStatusValue } from "@/lib/tickets/ticketContract";

interface PublicMessage {
  id: number;
  body: string;
  created: string;
  author: string;
  fromStaff: boolean;
}

interface PublicAttachment {
  id: number;
  filename: string;
  url: string;
  uploadedBy: string | null;
  created: string;
}

interface PublicTicket {
  ticketNumber: string;
  subject: string;
  status: TicketStatusValue;
  created: string;
  messages: PublicMessage[];
  attachments: PublicAttachment[];
}

const dateTimeFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function TicketStatusView({ token }: Readonly<{ token: string }>) {
  const [ticket, setTicket] = useState<PublicTicket | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/tickets/public/${token}`);
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to load");
      const { ticket: t } = (await res.json()) as { ticket: PublicTicket };
      setTicket(t);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Could not load your request"));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function sendReply() {
    if (!reply.trim()) return;
    setSending(true);
    try {
      const res = await fetch(`/api/tickets/public/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: reply.trim() }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not send");
      setReply("");
      toast.success("Reply sent");
      await load();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Could not send your reply"));
    } finally {
      setSending(false);
    }
  }

  async function uploadAttachment(file: File) {
    setUploading(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch(`/api/tickets/public/${token}/attachment`, {
        method: "POST",
        body,
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Upload failed");
      toast.success("File attached");
      await load();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Upload failed"));
    } finally {
      setUploading(false);
    }
  }

  if (loading) return <p className="text-sh-gray">Loading…</p>;
  if (notFound)
    return (
      <div>
        <h1 className="font-serif text-3xl text-sh-navy">Request not found</h1>
        <p className="mt-2 text-sh-gray">
          This link doesn&apos;t match an open request. Check the link in your email, or start a new
          request on the support page.
        </p>
      </div>
    );
  if (!ticket) return null;

  return (
    <div>
      <header>
        <h1 className="font-serif text-3xl text-sh-navy">{ticket.subject}</h1>
        <p className="mt-1 text-sm text-sh-gray">
          <span className="font-mono">{ticket.ticketNumber}</span> · opened{" "}
          {dateTimeFmt.format(new Date(ticket.created))} ·{" "}
          <span className="font-medium text-sh-black">{TICKET_STATUS_LABELS[ticket.status]}</span>
        </p>
      </header>

      <section className="mt-6 space-y-3">
        {ticket.messages.map((m) => (
          <div
            key={m.id}
            className={`rounded-md border p-3 text-sm ${
              m.fromStaff ? "border-sh-blue/20 bg-sh-blue/5" : "border-black/10 bg-white"
            }`}
          >
            <div className="mb-1 flex items-center justify-between text-xs text-sh-gray">
              <span className="font-medium text-sh-black">{m.author}</span>
              <span>{dateTimeFmt.format(new Date(m.created))}</span>
            </div>
            <p className="whitespace-pre-wrap text-sh-black">{m.body}</p>
          </div>
        ))}
      </section>

      <section className="mt-6">
        <h2 className="text-sm font-medium text-sh-black">Attachments</h2>
        {ticket.attachments.length === 0 ? (
          <p className="mt-1 text-sm text-sh-gray">No files attached yet.</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {ticket.attachments.map((a) => (
              <li key={a.id} className="text-sm">
                <a
                  href={a.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sh-navy hover:underline"
                >
                  {a.filename}
                </a>
                <span className="text-sh-gray"> · {a.uploadedBy ?? ""}</span>
              </li>
            ))}
          </ul>
        )}
        <label className="mt-2 inline-flex min-h-[44px] cursor-pointer items-center rounded-md border border-black/15 px-4 text-sm text-sh-navy transition hover:bg-black/5">
          {uploading ? "Uploading…" : "Attach a file (image or PDF, max 10MB)"}
          <input
            type="file"
            accept=".jpg,.jpeg,.png,.webp,.heic,.pdf"
            className="hidden"
            disabled={uploading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) uploadAttachment(f);
              e.target.value = "";
            }}
          />
        </label>
      </section>

      <section className="mt-6">
        <label className="block text-sm font-medium text-sh-black">
          Add a reply
          <textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            rows={4}
            className="mt-1 w-full rounded-md border border-black/15 px-3 py-2 text-sm focus:border-sh-navy focus:outline-none"
          />
        </label>
        <button
          type="button"
          onClick={sendReply}
          disabled={sending || !reply.trim()}
          className="mt-2 min-h-[44px] rounded-md bg-sh-navy px-6 py-3 text-sm font-medium text-white transition hover:bg-sh-blue disabled:opacity-60"
        >
          {sending ? "Sending…" : "Send reply"}
        </button>
      </section>
    </div>
  );
}
