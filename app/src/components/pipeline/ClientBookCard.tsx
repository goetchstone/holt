// /app/src/components/pipeline/ClientBookCard.tsx

import { useState } from "react";
import { ChevronRight, ClipboardList, StickyNote } from "lucide-react";
import { LeadScoreBadge } from "@/components/customer/LeadScoreBadge";
import { ClientActionChip, ClientContactChips } from "@/components/pipeline/ClientActionChip";
import { ClientInfoSummary } from "@/components/pipeline/ClientInfoSummary";
import { ClientHistoryLine } from "@/components/pipeline/QuoteClientPanel";
import type { ClientBookRow } from "@/lib/clientBookQuery";
import { clientInfoTexts, hasClientInfo } from "@/lib/clientProfile";
import { findMatchingText } from "@/lib/pipelineFilters";
import { parseLocalDate } from "@/lib/dateUtils";
import { INTERACTION_SOURCE_LABELS, type InteractionSource } from "@/lib/interactionSources";

function clientName(client: ClientBookRow): string {
  return `${client.firstName ?? ""} ${client.lastName ?? ""}`.trim() || "No name";
}

function pluralize(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function unownedLine(client: ClientBookRow): string {
  const parts = [`Last with ${client.lastSalesperson ?? "no one on record"}`];
  if (client.openQuotes > 0) {
    parts.push(`${pluralize(client.openQuotes, "open quote")} with no owner`);
  }
  return parts.join(" · ");
}

function staffLine(client: ClientBookRow, staffName: string): string {
  const parts: string[] = [];
  if (client.ordersWithStaff > 0 && client.lastOrderWithStaff) {
    const last = parseLocalDate(client.lastOrderWithStaff).toLocaleDateString("en-US", {
      month: "short",
      year: "numeric",
    });
    parts.push(`${pluralize(client.ordersWithStaff, "order")} with ${staffName}, last ${last}`);
  } else if (client.isAssigned) {
    parts.push(`Assigned to ${staffName}`);
  } else {
    parts.push(`Quoted by ${staffName}, never bought from them`);
  }
  if (client.openQuotes > 0) parts.push(pluralize(client.openQuotes, "open quote"));
  return parts.join(" · ");
}

function AssignClient({
  options,
  onAssign,
}: Readonly<{
  options: { id: number; displayName: string }[];
  onAssign: (staffId: number) => void;
}>) {
  return (
    <select
      aria-label="Assign this client to a salesperson"
      value=""
      onChange={(e) => onAssign(Number.parseInt(e.target.value, 10))}
      className="rounded-lg border border-brand-gold/60 bg-white px-3 text-xs font-semibold text-brand-black min-h-[44px] focus:border-brand-blue focus:outline-none"
    >
      <option value="" disabled>
        Assign to...
      </option>
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.displayName}
        </option>
      ))}
    </select>
  );
}

export function ClientBookCard({
  client,
  staffName,
  searchTerm,
  assignOptions,
  onAssign,
  onAddNote,
  onClientInfo,
}: Readonly<{
  client: ClientBookRow;
  staffName: string | null; // null when listing clients no one owns
  searchTerm: string;
  assignOptions: { id: number; displayName: string }[];
  onAssign: (client: ClientBookRow, staffId: number) => void;
  onAddNote: (client: ClientBookRow) => void;
  onClientInfo: (client: ClientBookRow) => void;
}>) {
  const [showNotes, setShowNotes] = useState(false);
  const latestNote = client.notes[0];
  const matchedText = searchTerm
    ? findMatchingText(
        [...client.notes.map((note) => note.notes), ...clientInfoTexts(client.profile)],
        searchTerm,
      )
    : null;

  return (
    <div className="bg-white rounded-xl border border-brand-gray/15 shadow-sm p-4 space-y-2">
      <div className="flex items-center gap-1.5 flex-wrap">
        <p className="font-semibold text-brand-black text-base leading-tight">
          {clientName(client)}
        </p>
        <LeadScoreBadge tier={client.leadTier} />
      </div>
      <p className="text-xs text-brand-gray">
        {staffName === null ? unownedLine(client) : staffLine(client, staffName)}
      </p>
      <ClientHistoryLine history={client.history} />

      <div className="flex flex-wrap gap-2 pt-1">
        {assignOptions.length > 0 && (
          <AssignClient options={assignOptions} onAssign={(staffId) => onAssign(client, staffId)} />
        )}
        <ClientContactChips customerId={client.id} phone={client.phone} email={client.email} />
        <ClientActionChip
          icon={<ClipboardList className="w-3.5 h-3.5" />}
          emphasis={!hasClientInfo(client.profile)}
          onClick={() => onClientInfo(client)}
        >
          {hasClientInfo(client.profile) ? "Edit client info" : "Add client info"}
        </ClientActionChip>
        <ClientActionChip
          icon={<StickyNote className="w-3.5 h-3.5" />}
          onClick={() => onAddNote(client)}
        >
          Add note
        </ClientActionChip>
      </div>

      {client.profile && hasClientInfo(client.profile) && (
        <ClientInfoSummary profile={client.profile} />
      )}

      {matchedText && (
        <p className="rounded-lg bg-brand-linen px-3 py-2 text-xs text-brand-black whitespace-pre-wrap break-words">
          <span className="font-semibold text-brand-gray">Matches: </span>
          {matchedText}
        </p>
      )}

      {latestNote && !showNotes && !matchedText && (
        <p className="text-xs text-brand-black line-clamp-2">
          <span className="text-brand-gray">Last note: </span>
          {latestNote.notes}
        </p>
      )}

      {client.notes.length > 0 && (
        <button
          type="button"
          onClick={() => setShowNotes(!showNotes)}
          aria-expanded={showNotes}
          className="inline-flex items-center gap-1 text-xs text-brand-gray hover:text-brand-blue min-h-[44px]"
        >
          <ChevronRight
            className={`w-3.5 h-3.5 transition-transform ${showNotes ? "rotate-90" : ""}`}
          />
          {client.notes.length} note{client.notes.length === 1 ? "" : "s"}
        </button>
      )}

      {showNotes && (
        <ul className="border-t border-brand-gray/10 pt-2 space-y-2">
          {client.notes.map((note) => (
            <li key={note.id} className="text-xs">
              <p className="text-brand-gray">
                {new Date(note.startedAt).toLocaleDateString("en-US")} ·{" "}
                {INTERACTION_SOURCE_LABELS[note.source as InteractionSource] ?? note.source} ·{" "}
                {note.staffName}
                {note.orderno && ` · ${note.orderno}`}
              </p>
              <p className="text-brand-black whitespace-pre-wrap break-words">{note.notes}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
