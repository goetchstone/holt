// /app/src/app/(dashboard)/app/helpdesk/HelpdeskQueueView.tsx
//
// Staff helpdesk queue. Lists tickets from /api/tickets with an Open/All filter
// and free-text search. Sorted open-first, then by priority, then most-recently
// active. Rows link to the single-ticket workspace.

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "react-toastify";
import { getErrorMessage } from "@/lib/toastError";
import {
  TICKET_STATUS_LABELS,
  TICKET_PRIORITY_LABELS,
  TICKET_PRIORITY_RANK,
  isOpenTicketStatus,
} from "@/lib/tickets/ticketContract";
import type { TicketStatusValue, TicketPriorityValue } from "@/lib/tickets/ticketContract";

interface TicketRow {
  id: number;
  ticketNumber: string;
  subject: string;
  status: TicketStatusValue;
  priority: TicketPriorityValue;
  submitterName: string | null;
  submitterEmail: string | null;
  created: string;
  updated: string | null;
  assignedTo: { id: number; displayName: string } | null;
  customer: { id: number; firstName: string | null; lastName: string | null } | null;
  _count: { messages: number };
}

const dateTimeFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

const STATUS_STYLES: Record<TicketStatusValue, string> = {
  OPEN: "bg-blue-100 text-blue-800",
  IN_PROGRESS: "bg-sh-gold/20 text-sh-gold",
  WAITING_ON_CUSTOMER: "bg-amber-100 text-amber-800",
  RESOLVED: "bg-green-100 text-green-800",
  CLOSED: "bg-black/5 text-sh-gray",
};

const PRIORITY_STYLES: Record<TicketPriorityValue, string> = {
  URGENT: "bg-red-100 text-red-800",
  HIGH: "bg-sh-gold/20 text-sh-gold",
  MEDIUM: "bg-black/5 text-sh-gray",
  LOW: "bg-black/5 text-sh-gray",
};

function sortQueue(tickets: TicketRow[]): TicketRow[] {
  return [...tickets].sort((a, b) => {
    const openDelta =
      (isOpenTicketStatus(a.status) ? 0 : 1) - (isOpenTicketStatus(b.status) ? 0 : 1);
    if (openDelta !== 0) return openDelta;
    const priorityDelta = TICKET_PRIORITY_RANK[a.priority] - TICKET_PRIORITY_RANK[b.priority];
    if (priorityDelta !== 0) return priorityDelta;
    return new Date(b.updated ?? b.created).getTime() - new Date(a.updated ?? a.created).getTime();
  });
}

export function HelpdeskQueueView() {
  const [tickets, setTickets] = useState<TicketRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState<"open" | "all">("open");
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (scope === "open") params.set("status", "open");
      if (search.trim()) params.set("q", search.trim());
      const res = await fetch(`/api/tickets?${params.toString()}`);
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to load tickets");
      const data = (await res.json()) as { tickets: TicketRow[] };
      setTickets(sortQueue(data.tickets));
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to load tickets"));
    } finally {
      setLoading(false);
    }
  }, [scope, search]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <h1 className="text-2xl font-semibold text-sh-blue">Helpdesk</h1>
      <p className="mt-1 text-sm text-sh-gray">
        Support requests from the public <span className="font-mono">/support</span> form and your
        team.
      </p>

      <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="inline-flex overflow-hidden rounded-md border border-black/10">
          {(["open", "all"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setScope(s)}
              className={`min-h-[44px] px-4 text-sm font-medium transition ${
                scope === s ? "bg-sh-navy text-white" : "bg-white text-sh-gray hover:bg-sh-stripe"
              }`}
            >
              {s === "open" ? "Open" : "All"}
            </button>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void load();
          }}
          className="flex gap-2"
        >
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search ticket #, subject, name…"
            className="min-h-[44px] w-64 rounded-md border border-black/15 px-3 text-sm"
          />
          <button
            type="submit"
            className="min-h-[44px] rounded-md bg-sh-navy px-4 text-sm font-medium text-white transition hover:bg-sh-blue"
          >
            Search
          </button>
        </form>
      </div>

      <div className="mt-6">{renderTable(tickets, loading)}</div>
    </div>
  );
}

function renderTable(tickets: TicketRow[], loading: boolean) {
  if (loading) return <p className="text-sh-gray">Loading…</p>;
  if (tickets.length === 0) return <p className="text-sh-gray">No tickets match this view.</p>;
  return (
    <div className="overflow-hidden rounded-md border border-black/10">
      <table className="w-full text-left text-sm">
        <thead className="bg-sh-stripe text-sh-gray">
          <tr>
            <th className="px-3 py-2 font-medium">Ticket</th>
            <th className="px-3 py-2 font-medium">Subject</th>
            <th className="px-3 py-2 font-medium">From</th>
            <th className="px-3 py-2 font-medium">Priority</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Owner</th>
            <th className="px-3 py-2 font-medium">Updated</th>
          </tr>
        </thead>
        <tbody>
          {tickets.map((t) => (
            <tr key={t.id} className="border-t border-black/5 align-top hover:bg-sh-stripe/50">
              <td className="px-3 py-2">
                <Link
                  href={`/app/helpdesk/${t.id}`}
                  className="font-mono text-xs font-semibold text-sh-blue hover:underline"
                >
                  {t.ticketNumber}
                </Link>
              </td>
              <td className="px-3 py-2 text-sh-black">
                <Link href={`/app/helpdesk/${t.id}`} className="hover:underline">
                  {t.subject}
                </Link>
                {t._count.messages > 1 ? (
                  <span className="ml-1 text-xs text-sh-gray">({t._count.messages})</span>
                ) : null}
              </td>
              <td className="px-3 py-2 text-sh-gray">
                {t.submitterName ?? "—"}
                {t.submitterEmail ? (
                  <span className="block text-xs">{t.submitterEmail}</span>
                ) : null}
              </td>
              <td className="px-3 py-2">
                <span className={`rounded px-2 py-0.5 text-xs ${PRIORITY_STYLES[t.priority]}`}>
                  {TICKET_PRIORITY_LABELS[t.priority]}
                </span>
              </td>
              <td className="px-3 py-2">
                <span className={`rounded px-2 py-0.5 text-xs ${STATUS_STYLES[t.status]}`}>
                  {TICKET_STATUS_LABELS[t.status]}
                </span>
              </td>
              <td className="px-3 py-2 text-sh-gray">
                {t.assignedTo?.displayName ?? "Unassigned"}
              </td>
              <td className="px-3 py-2 text-xs text-sh-gray">
                {dateTimeFmt.format(new Date(t.updated ?? t.created))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
