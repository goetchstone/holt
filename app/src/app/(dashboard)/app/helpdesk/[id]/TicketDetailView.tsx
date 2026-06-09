// /app/src/app/(dashboard)/app/helpdesk/[id]/TicketDetailView.tsx
//
// Single-ticket workspace: triage controls (status / priority / assignee), the
// full message thread including internal notes, and a reply box that can post a
// public reply or an internal note. All work goes through the /api/tickets REST
// endpoints; the view reloads after each mutation so it always reflects the DB.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "react-toastify";
import { getErrorMessage } from "@/lib/toastError";
import {
  TICKET_STATUS_LABELS,
  TICKET_STATUS_VALUES,
  TICKET_PRIORITY_LABELS,
  TICKET_PRIORITY_VALUES,
  getValidTicketTransitions,
} from "@/lib/tickets/ticketContract";
import type { TicketStatusValue, TicketPriorityValue } from "@/lib/tickets/ticketContract";

interface TicketMessage {
  id: number;
  body: string;
  isInternal: boolean;
  created: string;
  authorName: string | null;
  authorStaff: { id: number; displayName: string } | null;
}

interface TicketDetail {
  id: number;
  ticketNumber: string;
  publicToken: string;
  subject: string;
  status: TicketStatusValue;
  priority: TicketPriorityValue;
  submitterName: string | null;
  submitterEmail: string | null;
  created: string;
  resolvedAt: string | null;
  assignedTo: { id: number; displayName: string } | null;
  customer: { id: number; firstName: string | null; lastName: string | null } | null;
  messages: TicketMessage[];
}

interface StaffOption {
  id: number;
  displayName: string;
}

const dateTimeFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function TicketDetailView({ ticketId }: Readonly<{ ticketId: number }>) {
  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);

  // Local triage edits (initialised from the loaded ticket).
  const [status, setStatus] = useState<TicketStatusValue>("OPEN");
  const [priority, setPriority] = useState<TicketPriorityValue>("MEDIUM");
  const [assigneeId, setAssigneeId] = useState<string>("");

  const [reply, setReply] = useState("");
  const [internal, setInternal] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [tRes, sRes] = await Promise.all([
        fetch(`/api/tickets/${ticketId}`),
        fetch("/api/staff"),
      ]);
      if (!tRes.ok) throw new Error((await tRes.json()).error ?? "Failed to load ticket");
      const { ticket: t } = (await tRes.json()) as { ticket: TicketDetail };
      setTicket(t);
      setStatus(t.status);
      setPriority(t.priority);
      setAssigneeId(t.assignedTo ? String(t.assignedTo.id) : "");
      if (sRes.ok) {
        const list = (await sRes.json()) as StaffOption[];
        setStaff(list.map((s) => ({ id: s.id, displayName: s.displayName })));
      }
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to load ticket"));
    } finally {
      setLoading(false);
    }
  }, [ticketId]);

  useEffect(() => {
    void load();
  }, [load]);

  const statusOptions = useMemo(() => {
    if (!ticket) return TICKET_STATUS_VALUES;
    return Array.from(new Set([ticket.status, ...getValidTicketTransitions(ticket.status)]));
  }, [ticket]);

  async function saveTriage() {
    if (!ticket) return;
    const patch: Record<string, unknown> = {};
    if (status !== ticket.status) patch.status = status;
    if (priority !== ticket.priority) patch.priority = priority;
    const currentAssignee = ticket.assignedTo ? String(ticket.assignedTo.id) : "";
    if (assigneeId !== currentAssignee) patch.assignedToId = assigneeId ? Number(assigneeId) : null;
    if (Object.keys(patch).length === 0) {
      toast.info("No changes to save");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/tickets/${ticketId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Update failed");
      toast.success("Ticket updated");
      await load();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Could not update ticket"));
    } finally {
      setSaving(false);
    }
  }

  async function sendReply() {
    if (!reply.trim()) return;
    setSending(true);
    try {
      const res = await fetch(`/api/tickets/${ticketId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: reply.trim(), isInternal: internal }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not send");
      setReply("");
      setInternal(false);
      await load();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Could not send message"));
    } finally {
      setSending(false);
    }
  }

  async function copyPublicLink() {
    if (!ticket) return;
    const url = `${window.location.origin}/support/${ticket.publicToken}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Customer link copied");
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Could not copy the link"));
    }
  }

  if (loading) return <p className="text-sh-gray">Loading…</p>;
  if (!ticket) return <p className="text-sh-gray">Ticket not found.</p>;

  return (
    <div>
      <Link href="/app/helpdesk" className="text-sm text-sh-blue hover:underline">
        ← Back to queue
      </Link>

      <div className="mt-3 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-sh-blue">{ticket.subject}</h1>
          <p className="text-sm text-sh-gray">
            <span className="font-mono">{ticket.ticketNumber}</span> · opened{" "}
            {dateTimeFmt.format(new Date(ticket.created))} by {ticket.submitterName ?? "—"}
            {ticket.submitterEmail ? ` (${ticket.submitterEmail})` : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={copyPublicLink}
          className="min-h-[44px] self-start rounded-md border border-sh-gray/30 px-4 text-sm font-medium text-sh-blue transition hover:bg-sh-stripe"
        >
          Copy customer link
        </button>
      </div>

      <section className="mt-5 grid gap-3 rounded-md border border-black/10 bg-sh-linen p-4 sm:grid-cols-4 sm:items-end">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-sh-black">Status</span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as TicketStatusValue)}
            className="min-h-[44px] w-full rounded-md border border-black/15 bg-white px-2 text-sm"
          >
            {statusOptions.map((s) => (
              <option key={s} value={s}>
                {TICKET_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-sh-black">Priority</span>
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value as TicketPriorityValue)}
            className="min-h-[44px] w-full rounded-md border border-black/15 bg-white px-2 text-sm"
          >
            {TICKET_PRIORITY_VALUES.map((p) => (
              <option key={p} value={p}>
                {TICKET_PRIORITY_LABELS[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-sh-black">Owner</span>
          <select
            value={assigneeId}
            onChange={(e) => setAssigneeId(e.target.value)}
            className="min-h-[44px] w-full rounded-md border border-black/15 bg-white px-2 text-sm"
          >
            <option value="">Unassigned</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.displayName}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={saveTriage}
          disabled={saving}
          className="min-h-[44px] rounded-md bg-sh-navy px-4 text-sm font-medium text-white transition hover:bg-sh-blue disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </section>

      <section className="mt-6 space-y-3">
        {ticket.messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
      </section>

      <section className="mt-6 rounded-md border border-black/10 p-4">
        <textarea
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          rows={4}
          placeholder={internal ? "Internal note (staff only)…" : "Reply to the customer…"}
          className="w-full rounded-md border border-black/15 px-3 py-2 text-sm"
        />
        <div className="mt-2 flex items-center justify-between">
          <label className="flex items-center gap-2 text-sm text-sh-gray">
            <input
              type="checkbox"
              checked={internal}
              onChange={(e) => setInternal(e.target.checked)}
              className="h-4 w-4"
            />
            Internal note (not shown to the customer)
          </label>
          <button
            type="button"
            onClick={sendReply}
            disabled={sending || !reply.trim()}
            className="min-h-[44px] rounded-md bg-sh-navy px-5 text-sm font-medium text-white transition hover:bg-sh-blue disabled:opacity-60"
          >
            {sending ? "Sending…" : internal ? "Add note" : "Send reply"}
          </button>
        </div>
      </section>
    </div>
  );
}

function MessageBubble({ message }: Readonly<{ message: TicketMessage }>) {
  const author = message.authorStaff?.displayName ?? message.authorName ?? "Customer";
  const fromStaff = message.authorStaff != null;
  const base = "rounded-md border p-3 text-sm";
  const tone = message.isInternal
    ? "border-amber-200 bg-amber-50"
    : fromStaff
      ? "border-sh-blue/20 bg-sh-blue/5"
      : "border-black/10 bg-white";
  return (
    <div className={`${base} ${tone}`}>
      <div className="mb-1 flex items-center justify-between text-xs text-sh-gray">
        <span className="font-medium text-sh-black">
          {author}
          {message.isInternal ? (
            <span className="ml-2 rounded bg-amber-200 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-900">
              Internal note
            </span>
          ) : null}
        </span>
        <span>{dateTimeFmt.format(new Date(message.created))}</span>
      </div>
      <p className="whitespace-pre-wrap text-sh-black">{message.body}</p>
    </div>
  );
}
