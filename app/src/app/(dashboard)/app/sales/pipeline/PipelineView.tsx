"use client";

// /app/src/app/(dashboard)/app/sales/pipeline/PipelineView.tsx
//
// Quote pipeline board body -- App Router port of the legacy
// pages/sales/pipeline.tsx (minus MainLayout chrome, which the (dashboard)
// layout supplies). Per-staff / all-staff scope, urgency buckets, follow-up
// logging, archive/restore with replacement linkage, bulk archive, and leads
// all read/write the shared /api/sales/pipeline + /api/sales/interactions REST
// endpoints exactly as before. Money is shown in whole units via
// useMoneyFormatter (matching the legacy whole-dollar display).

import { useState, useEffect, useCallback } from "react";
import axios from "axios";
import Link from "next/link";
import { Dialog, DialogBackdrop, DialogPanel } from "@headlessui/react";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import { parseLocalDate } from "@/lib/dateUtils";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import type {
  PipelineQuote,
  PipelineLead,
  PipelineResponse,
  StaffSummary,
} from "@/pages/api/sales/pipeline/index";
import { WealthTierBadge } from "@/components/customer/WealthTierBadge";
import { LeadScoreBadge } from "@/components/customer/LeadScoreBadge";
import { useDebounce } from "@/hooks/useDebounce";
import { useEffectiveRole } from "@/lib/hooks/useEffectiveRole";
import { ARCHIVE_REASONS, REPLACEMENT_REASONS } from "@/lib/quoteArchive";
import { getErrorMessage } from "@/lib/toastError";
import { usePersistentFilters } from "@/hooks/usePersistentFilters";
import { ClientInfoModal } from "@/components/pipeline/ClientInfoModal";
import { ClientNoteModal } from "@/components/pipeline/ClientNoteModal";
import { LogContactModal } from "@/components/pipeline/LogContactModal";
import { PipelineFilterBar } from "@/components/pipeline/PipelineFilterBar";
import { QuoteClientPanel } from "@/components/pipeline/QuoteClientPanel";
import {
  INTERACTION_SOURCE_LABELS,
  type InteractionSource,
} from "@/lib/interactionSources";
import {
  countActiveFilters,
  DEFAULT_PIPELINE_FILTERS,
  filterPipelineQuotes,
  findMatchingNote,
  sortPipelineQuotes,
  storeFilterOptions,
} from "@/lib/pipelineFilters";
import { needsAttention } from "@/lib/pipelineFollowUp";
import { DEFAULT_CLIENT_PROFILE_CHOICES } from "@/lib/clientProfile";

const ON_TRACK_URGENCY = {
  dot: "bg-green-500",
  badge: "bg-green-50 text-green-700 border-green-200",
};
const OVERDUE_URGENCY = { dot: "bg-red-500", badge: "bg-red-50 text-red-700 border-red-200" };

function urgencyClass(quote: PipelineQuote) {
  if (quote.followUpState === "scheduled") return ON_TRACK_URGENCY;
  if (quote.followUpState === "due") return OVERDUE_URGENCY;
  const days = quote.daysSinceContact ?? quote.daysSinceCreated;
  if (days > 14) return OVERDUE_URGENCY;
  if (days > 7)
    return { dot: "bg-amber-500", badge: "bg-amber-50 text-amber-700 border-amber-200" };
  if (days > 3)
    return { dot: "bg-yellow-400", badge: "bg-yellow-50 text-yellow-700 border-yellow-200" };
  return ON_TRACK_URGENCY;
}

function urgencyLabel(quote: PipelineQuote): string {
  const nextDate = quote.customer?.profile?.nextFollowUpDate;
  if (quote.followUpState === "due") return "Due";
  if (quote.followUpState === "scheduled" && nextDate) {
    return parseLocalDate(nextDate).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  }
  const days = quote.daysSinceContact ?? quote.daysSinceCreated;
  return days === 0 ? "Today" : `${days}d`;
}

function daysLabel(n: number): string {
  if (n === 0) return "Today";
  if (n === 1) return "Yesterday";
  return `${n}d ago`;
}

function lastContactLabel(daysSinceContact: number, interactionCount: number): string {
  const base = `Last contact ${daysLabel(daysSinceContact)}`;
  if (interactionCount > 0) return `${base} (${interactionCount})`;
  return base;
}

function contactSummary(quote: PipelineQuote): string {
  const count = quote.interactions.length;
  if (quote.lastInteractionAt) return lastContactLabel(quote.daysSinceContact ?? 0, count);
  return count > 0 ? `No follow-up yet (${count})` : "No follow-up yet";
}

function computePageTitle(viewingStaffName: string | null | undefined, scope: string): string {
  if (viewingStaffName) return `${viewingStaffName}'s Pipeline`;
  if (scope === "all") return "All Staff Pipeline";
  return "My Pipeline";
}

function formatQuoteDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function customerDisplayName(quote: PipelineQuote): string {
  if (!quote.customer) return "Unknown customer";
  return `${quote.customer.firstName ?? ""} ${quote.customer.lastName ?? ""}`.trim();
}

// ── Archive modal ─────────────────────────────────────────────────────────────

// Reasons are imported from @/lib/quoteArchive — the single source of truth
// shared with the PATCH endpoint. Do not declare a local list here.

interface ReplacementCandidate {
  id: number;
  orderno: string;
  orderDate: string | null;
  totalAmount: number;
}

function ArchiveModal({
  quote,
  onClose,
  onSaved,
  suggestions,
}: Readonly<{
  quote: PipelineQuote;
  onClose: () => void;
  onSaved: () => void;
  // Other active quotes for the same customer, pre-filtered to exclude self.
  suggestions: ReplacementCandidate[];
}>) {
  const currency = useMoneyFormatter();
  const [reason, setReason] = useState<string>("");
  const [note, setNote] = useState("");
  const [replacedByOrderId, setReplacedByOrderId] = useState<number | null>(
    suggestions[0]?.id ?? null,
  );
  const [saving, setSaving] = useState(false);

  const needsReplacement = (REPLACEMENT_REASONS as ReadonlySet<string>).has(reason);

  async function handleArchive() {
    setSaving(true);
    try {
      await axios.patch(`/api/sales/pipeline/${quote.id}`, {
        archived: true,
        reason: reason || undefined,
        note: note.trim() || undefined,
        replacedByOrderId: needsReplacement ? replacedByOrderId : null,
      });
      toast.success("Quote archived.");
      onSaved();
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to archive quote."));
    } finally {
      setSaving(false);
    }
  }

  return (
    // Headless UI Dialog handles focus-trap, Escape, and click-outside
    // a11y natively. See FollowUpModal above for the same pattern.
    <Dialog open onClose={onClose} className="relative z-50">
      <DialogBackdrop className="fixed inset-0 bg-black/40" />
      <div className="fixed inset-0 flex items-end sm:items-center justify-center p-4">
        <DialogPanel className="bg-white rounded-xl shadow-2xl w-full max-w-md p-6 space-y-5">
          <div>
            <h2 className="text-lg font-semibold text-brand-black font-serif">Archive Quote</h2>
            <p className="text-sm text-brand-gray mt-0.5">
              {quote.customer ? customerDisplayName(quote) : "Unknown customer"} · {quote.orderno} ·{" "}
              {currency(quote.totalAmount, { whole: true })}
            </p>
          </div>

          <div>
            <p className="text-xs text-brand-gray uppercase tracking-wide mb-2">Reason</p>
            <div className="flex flex-wrap gap-2 mb-3">
              {ARCHIVE_REASONS.map((r) => (
                <button
                  key={r}
                  onClick={() => setReason(reason === r ? "" : r)}
                  className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                    reason === r
                      ? "bg-brand-blue text-white border-brand-blue"
                      : "border-brand-gray/30 text-brand-gray hover:border-brand-blue"
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>

          {needsReplacement && (
            <div>
              <p className="text-xs text-brand-gray uppercase tracking-wide mb-2">
                Replaced by which quote?
              </p>
              {suggestions.length === 0 ? (
                <p className="text-sm text-brand-gray italic">
                  No other active quotes for this customer. Archive will still record the reason.
                </p>
              ) : (
                <select
                  value={replacedByOrderId ?? ""}
                  onChange={(e) =>
                    setReplacedByOrderId(
                      e.target.value ? Number.parseInt(e.target.value, 10) : null,
                    )
                  }
                  className="w-full border border-brand-gray/30 rounded-lg px-3 py-2 text-sm text-brand-black focus:outline-none focus:ring-1 focus:ring-brand-blue min-h-[44px]"
                  aria-label="Replacement quote"
                >
                  <option value="">— Not specified —</option>
                  {suggestions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.orderno} · {currency(s.totalAmount, { whole: true })}
                      {s.orderDate ? ` · ${parseLocalDate(s.orderDate).toLocaleDateString()}` : ""}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          <div>
            <label
              htmlFor="archive-note"
              className="block text-xs text-brand-gray uppercase tracking-wide mb-2"
            >
              Note (optional)
            </label>
            <textarea
              id="archive-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="Add context for the archive..."
              className="w-full border border-brand-gray/30 rounded-lg px-3 py-2 text-sm text-brand-black resize-none focus:outline-none focus:ring-1 focus:ring-brand-blue"
            />
          </div>

          <div className="flex gap-3 pt-1">
            <Button
              onClick={handleArchive}
              disabled={saving}
              className="flex-1 min-h-[44px] bg-brand-gray hover:bg-brand-black"
            >
              {saving ? "Archiving..." : "Archive Quote"}
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

// ── Quote card ───────────────────────────────────────────────────────────────

function QuoteCard({
  quote,
  onFollowUp,
  onAddNote,
  onClientInfo,
  onArchive,
  onRestore,
  isArchived,
  searchTerm = "",
}: Readonly<{
  quote: PipelineQuote;
  onFollowUp?: (q: PipelineQuote) => void;
  onAddNote?: (q: PipelineQuote) => void;
  onClientInfo?: (q: PipelineQuote) => void;
  onArchive?: (q: PipelineQuote) => void;
  onRestore?: (q: PipelineQuote) => void;
  isArchived?: boolean;
  searchTerm?: string;
}>) {
  const currency = useMoneyFormatter();
  const { effectiveRole } = useEffectiveRole();
  const [showHistory, setShowHistory] = useState(false);
  // Most recent note, shown on active cards so nobody has to expand the history for it.
  const lastNote = quote.interactions.find((ix) => ix.notes)?.notes ?? null;
  // A search can hit an older note, so show the match instead of the newest one.
  const matchedNote = searchTerm ? findMatchingNote(quote, searchTerm) : null;
  const urgency = urgencyClass(quote);
  const customerName = quote.customer
    ? `${quote.customer.firstName ?? ""} ${quote.customer.lastName ?? ""}`.trim() || "No name"
    : "No customer";
  const canSeeWealth =
    effectiveRole === "ADMIN" || effectiveRole === "SUPER_ADMIN" || effectiveRole === "MARKETING";

  return (
    // Card is an <a> for proper a11y + native middle-click / right-click
    // open-in-new-tab. Inner action buttons stopPropagation so they don't
    // also navigate.
    <Link
      href={`/app/sales/orders/${quote.id}`}
      className={`bg-white rounded-xl border shadow-sm p-4 flex gap-4 cursor-pointer no-underline text-inherit ${
        isArchived
          ? "border-brand-gray/10 opacity-75"
          : "border-brand-gray/15 hover:border-brand-blue/30 hover:shadow-md"
      } transition-all`}
    >
      <div className="flex flex-col items-center pt-1 gap-2 shrink-0">
        <div
          className={`w-2.5 h-2.5 rounded-full ${isArchived ? "bg-brand-gray/40" : urgency.dot}`}
        />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <p className="font-semibold text-brand-black text-base leading-tight truncate">
                {customerName}
              </p>
              <LeadScoreBadge tier={quote.customer?.leadTier} score={quote.customer?.leadScore} />
              {canSeeWealth && <WealthTierBadge tier={quote.customer?.wealthTier} />}
            </div>
            <p className="text-xs text-brand-gray mt-0.5">
              <span className="text-brand-blue">{quote.orderno}</span>
              {quote.storeLocation && ` · ${quote.storeLocation}`}
              {quote.salesperson && ` · ${quote.salesperson}`}
              {quote.quoteDate && ` · ${formatQuoteDate(quote.quoteDate)}`}
            </p>
          </div>
          <div className="text-right shrink-0">
            <p className="font-semibold text-brand-black">
              {currency(quote.totalAmount, { whole: true })}
            </p>
            {!isArchived && (
              <span
                className={`inline-block text-xs font-semibold px-2 py-0.5 rounded-full border mt-1 ${urgency.badge}`}
              >
                {urgencyLabel(quote)}
              </span>
            )}
          </div>
        </div>

        <p className="text-xs text-brand-gray mt-2 truncate">{quote.lineItemSummary}</p>

        {!isArchived && quote.possibleDuplicateOf.length > 0 && (
          <p className="text-xs text-amber-700 mt-1.5 font-medium">
            Possible duplicate of{" "}
            {quote.possibleDuplicateOf.map((d, i) => (
              <span key={d.id}>
                {i > 0 && ", "}
                {d.orderno}
              </span>
            ))}
          </p>
        )}

        {isArchived && quote.replacedByOrderno && (
          <p className="text-xs text-brand-blue mt-1.5">
            Replaced by{" "}
            <Link
              href={`/app/sales/orders/${quote.replacedByOrderId}`}
              onClick={(e) => e.stopPropagation()}
              className="underline font-medium"
            >
              {quote.replacedByOrderno}
            </Link>
          </p>
        )}

        {isArchived && quote.archiveReason && (
          <p className="text-xs text-brand-gray mt-1">Reason: {quote.archiveReason}</p>
        )}

        {isArchived && quote.pipelineNote && (
          <p className="text-xs text-brand-gray mt-1 italic">{quote.pipelineNote}</p>
        )}

        {!isArchived && onClientInfo && (
          <QuoteClientPanel quote={quote} onClientInfo={onClientInfo} />
        )}

        <div className="flex items-center justify-between mt-3 gap-2">
          {isArchived ? (
            <p className="text-xs text-brand-gray">
              Archived{" "}
              {quote.pipelineArchivedAt
                ? daysLabel(
                    Math.floor(
                      (Date.now() - new Date(quote.pipelineArchivedAt).getTime()) / 86400000,
                    ),
                  )
                : ""}
            </p>
          ) : (
            <button
              onClick={(e) => {
                // Same pattern as the action buttons below — preventDefault
                // stops the outer <Link> from navigating away when the
                // user toggles the history dropdown.
                e.preventDefault();
                e.stopPropagation();
                if (quote.interactions.length > 0) setShowHistory(!showHistory);
              }}
              className={`text-xs text-left ${quote.lastInteractionAt ? "text-brand-gray hover:text-brand-blue" : "text-amber-600 font-medium"}`}
            >
              {contactSummary(quote)}
            </button>
          )}
          <div className="flex gap-2 shrink-0">
            {isArchived ? (
              <button
                onClick={(e) => {
                  // The card itself is a <Link href="...">, so action
                  // buttons MUST call both preventDefault (stop the
                  // anchor's navigation) AND stopPropagation (stop
                  // bubbling to any other handlers). Without
                  // preventDefault, the modal flashes open for a frame
                  // and the browser then navigates to the quote
                  // detail page — user-reported bug 2026-05-05.
                  e.preventDefault();
                  e.stopPropagation();
                  onRestore?.(quote);
                }}
                className="text-xs font-semibold text-brand-blue border border-brand-blue/40 rounded-lg px-3 py-1.5 hover:bg-brand-blue hover:text-white transition-colors min-h-[36px]"
              >
                Restore
              </button>
            ) : (
              <>
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onArchive?.(quote);
                  }}
                  className="text-xs text-brand-gray border border-brand-gray/30 rounded-lg px-3 py-1.5 hover:bg-brand-linen transition-colors min-h-[36px]"
                >
                  Archive
                </button>
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onAddNote?.(quote);
                  }}
                  className="text-xs font-semibold text-brand-blue border border-brand-gray/30 rounded-lg px-3 py-1.5 min-h-[44px] hover:bg-brand-linen transition-colors"
                >
                  Add Note
                </button>
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onFollowUp?.(quote);
                  }}
                  className="text-xs font-semibold text-brand-blue border border-brand-blue/40 rounded-lg px-3 py-1.5 hover:bg-brand-blue hover:text-white transition-colors min-h-[36px]"
                >
                  Follow Up
                </button>
              </>
            )}
          </div>
        </div>

        {matchedNote && (
          <p className="mt-2 rounded-lg bg-brand-linen px-3 py-2 text-xs text-brand-black whitespace-pre-wrap break-words">
            <span className="font-semibold text-brand-gray">Matches: </span>
            {matchedNote}
          </p>
        )}

        {!isArchived && !matchedNote && lastNote && (
          <p className="mt-2 text-xs text-brand-black line-clamp-2" title={lastNote}>
            <span className="text-brand-gray">Last note: </span>
            {lastNote}
          </p>
        )}

        {showHistory && quote.interactions.length > 0 && (
          <div className="mt-3 pt-3 border-t border-brand-gray/10 space-y-2">
            {quote.interactions.map((ix) => (
              <div key={ix.id} className="flex gap-2 text-xs">
                <span className="text-brand-gray shrink-0 w-16">
                  {new Date(ix.startedAt).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  })}
                </span>
                <span className="shrink-0 px-1.5 py-0.5 rounded bg-brand-linen text-brand-gray font-medium">
                  {INTERACTION_SOURCE_LABELS[ix.source as InteractionSource] ?? ix.source}
                </span>
                <span className="text-brand-gray shrink-0">{ix.staffName}</span>
                {ix.notes && (
                  <span className="text-brand-black min-w-0 whitespace-pre-wrap break-words">
                    {ix.notes}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Link>
  );
}

// ── Lead card ────────────────────────────────────────────────────────────────

function LeadCard({ lead }: Readonly<{ lead: PipelineLead }>) {
  const name = [lead.firstName, lead.lastName].filter(Boolean).join(" ") || "Unknown";
  const sourceLabel: Record<string, string> = {
    MAILCHIMP_CLICK: "Email click",
    MAILCHIMP_OPEN: "Email open",
    WALK_IN: "Walk-in",
    PHONE: "Phone",
    REFERRAL: "Referral",
    WEBSITE: "Website",
    OTHER: "Other",
  };

  return (
    <div className="bg-white rounded-xl border border-brand-gold/30 shadow-sm p-4 flex gap-4">
      <div className="flex flex-col items-center pt-1 gap-2 shrink-0">
        <div className="w-2.5 h-2.5 rounded-full bg-brand-gold" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="font-semibold text-brand-black text-base leading-tight">{name}</p>
            <p className="text-xs text-brand-gray mt-0.5">
              {sourceLabel[lead.source] ?? lead.source} · {lead.status}
            </p>
          </div>
          <span className="text-xs text-brand-gray shrink-0">
            {daysLabel(lead.daysSinceCreated)}
          </span>
        </div>
        {(lead.phone || lead.email) && (
          <p className="text-xs text-brand-gray mt-1.5">
            {lead.phone && <span>{lead.phone}</span>}
            {lead.phone && lead.email && " · "}
            {lead.email && <span>{lead.email}</span>}
          </p>
        )}
        {lead.notes && <p className="text-xs text-brand-gray mt-1 italic truncate">{lead.notes}</p>}
        {lead.salesOrderId && (
          <Link
            href={`/app/sales/orders/${lead.salesOrderId}`}
            className="text-xs text-brand-blue hover:underline mt-1 block"
          >
            View quote →
          </Link>
        )}
      </div>
    </div>
  );
}

// ── Staff summary card ────────────────────────────────────────────────────────

function StaffSummaryCard({
  summary,
  onClick,
}: Readonly<{ summary: StaffSummary; onClick: () => void }>) {
  const currency = useMoneyFormatter();
  return (
    <button
      onClick={onClick}
      className="w-full text-left bg-white rounded-xl border border-brand-gray/15 shadow-sm p-4 hover:border-brand-blue/50 hover:shadow-md transition-all"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-brand-black text-base leading-tight truncate">
            {summary.displayName}
          </p>
          {summary.storeLocation && (
            <p className="text-xs text-brand-gray mt-0.5">{summary.storeLocation}</p>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-1 shrink-0">
          {summary.dueCount > 0 && (
            <span className="text-xs font-semibold bg-amber-50 text-amber-800 border border-amber-200 px-2 py-0.5 rounded-full shrink-0 whitespace-nowrap">
              {summary.dueCount} due
            </span>
          )}
          {summary.overdueCount > 0 && (
            <span className="text-xs font-semibold bg-red-50 text-red-700 border border-red-200 px-2 py-0.5 rounded-full shrink-0 whitespace-nowrap">
              {summary.overdueCount} overdue
            </span>
          )}
        </div>
      </div>
      <div className="flex gap-6 mt-4">
        <div>
          <p className="text-xs text-brand-gray uppercase tracking-wide">Pipeline</p>
          <p className="font-semibold text-brand-black text-lg">
            {currency(summary.totalValue, { whole: true })}
          </p>
        </div>
        <div>
          <p className="text-xs text-brand-gray uppercase tracking-wide">Quotes</p>
          <p className="font-semibold text-brand-black text-lg">{summary.quoteCount}</p>
        </div>
        {summary.leadCount > 0 && (
          <div>
            <p className="text-xs text-brand-gray uppercase tracking-wide">Leads</p>
            <p className="font-semibold text-brand-gold text-lg">{summary.leadCount}</p>
          </div>
        )}
      </div>
    </button>
  );
}

/**
 * Build the pipeline API URL based on the active scope. Extracted so
 * the dispatch isn't part of the page-level fetch flow's cog
 * complexity (S3776).
 */
function UnassignedCard({
  unassigned,
}: Readonly<{ unassigned: NonNullable<PipelineResponse["unassigned"]> }>) {
  const currency = useMoneyFormatter();
  if (unassigned.quoteCount === 0) return null;
  return (
    <Link
      href="/app/sales/clients?staff=unassigned"
      className="block bg-white rounded-xl border border-brand-gold/60 shadow-sm px-4 py-3 hover:shadow-md transition-shadow"
    >
      <p className="font-semibold text-brand-black text-base leading-tight">
        No owner: {unassigned.clientCount} client{unassigned.clientCount === 1 ? "" : "s"}
      </p>
      <p className="text-xs text-brand-gray mt-1">
        {unassigned.quoteCount} open quote{unassigned.quoteCount === 1 ? "" : "s"} no one is
        working, {currency(unassigned.totalValue, { whole: true })}. Assign them →
      </p>
    </Link>
  );
}

function summariesForStore(summaries: StaffSummary[], store: string): StaffSummary[] {
  if (store === DEFAULT_PIPELINE_FILTERS.store) return summaries;
  return summaries.filter((s) => s.storeLocation === store);
}

function buildPipelineUrl(
  scope: "mine" | "all",
  viewingStaffId: number | null,
  showArchived: boolean,
  search: string,
): string {
  // A name or note search returns matching open quotes across the pipeline (a manager
  // sees everyone's; a salesperson sees their own), ignoring scope.
  if (search) {
    return `/api/sales/pipeline?search=${encodeURIComponent(search)}&archived=${showArchived}`;
  }
  if (scope === "all" && viewingStaffId !== null) {
    return `/api/sales/pipeline?scope=staff&staffId=${viewingStaffId}&archived=${showArchived}`;
  }
  if (scope === "all") {
    return "/api/sales/pipeline?scope=all";
  }
  return `/api/sales/pipeline?scope=mine&archived=${showArchived}`;
}

/**
 * Compute the summary-bar totals shown above the pipeline. When the user
 * is on the all-staff grid, the totals come from per-staff summaries;
 * otherwise from the visible quotes + leads. Extracted to keep the
 * page component's cog complexity in check (S3776).
 */
function computeSummaryTotals(args: {
  isStaffGrid: boolean;
  summaries: StaffSummary[];
  quotes: PipelineQuote[];
  leads: PipelineLead[];
  needsAttention: PipelineQuote[];
}): {
  totalValue: number;
  totalQuotes: number;
  totalOverdue: number;
  totalLeads: number;
} {
  const { isStaffGrid, summaries, quotes, leads, needsAttention } = args;
  if (isStaffGrid) {
    return {
      totalValue: summaries.reduce((s, st) => s + st.totalValue, 0),
      totalQuotes: summaries.reduce((s, st) => s + st.quoteCount, 0),
      totalOverdue: summaries.reduce((s, st) => s + st.dueCount + st.overdueCount, 0),
      totalLeads: summaries.reduce((s, st) => s + st.leadCount, 0),
    };
  }
  return {
    totalValue: quotes.reduce((s, q) => s + q.totalAmount, 0),
    totalQuotes: quotes.length,
    totalOverdue: needsAttention.length,
    totalLeads: leads.length,
  };
}

/**
 * Build the list of "looks like a replacement" suggestions for the
 * archive modal: same-customer, non-archived, different-id quotes.
 * Extracted from the page render so the JSX above it doesn't carry the
 * filter+map cog complexity of an inline expression.
 */
function buildArchiveSuggestions(
  archiveTarget: PipelineQuote | null,
  quotes: PipelineQuote[],
): ReplacementCandidate[] {
  if (!archiveTarget?.customer?.id) return [];
  const targetCustomerId = archiveTarget.customer.id;
  return quotes
    .filter(
      (q) =>
        q.id !== archiveTarget.id && q.customer?.id === targetCustomerId && !q.pipelineArchivedAt,
    )
    .map((q) => ({
      id: q.id,
      orderno: q.orderno,
      orderDate: q.orderDate,
      totalAmount: q.totalAmount,
    }));
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function PipelineView() {
  const currency = useMoneyFormatter();
  const [data, setData] = useState<PipelineResponse | null>(null);
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const [viewingStaffId, setViewingStaffId] = useState<number | null>(null);
  const [viewingStaffName, setViewingStaffName] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [followUpTarget, setFollowUpTarget] = useState<PipelineQuote | null>(null);
  const [noteTarget, setNoteTarget] = useState<PipelineQuote | null>(null);
  const [clientInfoTarget, setClientInfoTarget] = useState<PipelineQuote | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<PipelineQuote | null>(null);
  const [filters, setFilters] = usePersistentFilters("pipeline-filters", DEFAULT_PIPELINE_FILTERS);
  const [refreshKey, setRefreshKey] = useState(0);
  const [bulkArchiving, setBulkArchiving] = useState(false);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search.trim());

  const fetchPipeline = useCallback(async () => {
    setLoading(true);
    try {
      const url = buildPipelineUrl(scope, viewingStaffId, showArchived, debouncedSearch);
      const res = await axios.get<PipelineResponse>(url);
      setData(res.data);
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to load pipeline."));
    } finally {
      setLoading(false);
    }
  }, [scope, viewingStaffId, showArchived, refreshKey, debouncedSearch]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchPipeline();
  }, [fetchPipeline]);

  function switchScope(next: "mine" | "all") {
    setScope(next);
    setViewingStaffId(null);
    setViewingStaffName(null);
    setShowArchived(false);
  }

  async function handleRestore(quote: PipelineQuote) {
    try {
      await axios.patch(`/api/sales/pipeline/${quote.id}`, { archived: false });
      toast.success("Quote restored to pipeline.");
      setRefreshKey((k) => k + 1);
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to restore quote."));
    }
  }

  async function handleBulkArchive() {
    if (!confirm("Archive all quotes created before 2026? They can be restored individually."))
      return;
    setBulkArchiving(true);
    try {
      const res = await axios.post<{ archived: number }>("/api/sales/pipeline/bulk-archive", {
        before: "2026-01-01",
      });
      toast.success(`Archived ${res.data.archived} quotes.`);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      toast.error(getErrorMessage(err, "Bulk archive failed."));
    } finally {
      setBulkArchiving(false);
    }
  }

  const searching = debouncedSearch.length > 0;
  // When searching, show the flat matching-quotes list instead of the staff grid.
  const isStaffGrid = scope === "all" && viewingStaffId === null && !searching;
  const quotes = data?.quotes ?? [];
  const today = data?.today ?? "";
  const hasFilters = countActiveFilters(filters) > 0;

  // Filters narrow the active list. The archived tab and the archive modal's replacement
  // suggestions always work from every quote.
  const visibleQuotes = sortPipelineQuotes(
    filterPipelineQuotes(quotes, filters, today),
    filters.sort,
  );
  const leads = hasFilters ? [] : (data?.leads ?? []);
  const allSummaries = data?.staffSummaries ?? [];
  const summaries = summariesForStore(allSummaries, filters.store);

  // Active pipeline buckets
  const attentionQuotes = visibleQuotes.filter((q) => needsAttention(q.followUpState));
  const active = visibleQuotes.filter((q) => !needsAttention(q.followUpState));

  const { totalValue, totalQuotes, totalOverdue, totalLeads } = computeSummaryTotals({
    isStaffGrid,
    summaries,
    quotes: visibleQuotes,
    leads,
    needsAttention: attentionQuotes,
  });

  function renderActiveCard(quote: PipelineQuote) {
    return (
      <QuoteCard
        key={quote.id}
        quote={quote}
        searchTerm={debouncedSearch}
        onFollowUp={setFollowUpTarget}
        onAddNote={setNoteTarget}
        onClientInfo={setClientInfoTarget}
        onArchive={setArchiveTarget}
      />
    );
  }

  const pageTitle = computePageTitle(viewingStaffName, scope);

  return (
    <div className="py-2 space-y-6 font-serif">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          {viewingStaffName && (
            <button
              onClick={() => {
                setViewingStaffId(null);
                setViewingStaffName(null);
                setShowArchived(false);
              }}
              className="text-brand-blue text-sm hover:underline shrink-0"
            >
              ← All Staff
            </button>
          )}
          <h1 className="text-2xl font-semibold text-brand-blue truncate">{pageTitle}</h1>
          <Link
            href="/app/sales/clients"
            className="text-sm text-brand-blue hover:underline shrink-0"
          >
            My Clients →
          </Link>
        </div>

        <div className="flex flex-wrap items-center gap-3 shrink-0">
          {/* Name or note search: looks up open quotes across the pipeline */}
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or notes…"
            aria-label="Search pipeline by customer name or notes"
            className="w-64 max-w-full rounded-lg border border-brand-gray/30 px-3 py-2 text-sm min-h-[44px]"
          />
          {/* Bulk archive — manager only, shown on active views */}
          {data?.canViewAll && !showArchived && !isStaffGrid && (
            <button
              onClick={handleBulkArchive}
              disabled={bulkArchiving}
              className="text-xs text-brand-gray border border-brand-gray/30 rounded-lg px-3 py-2 hover:bg-brand-linen transition-colors min-h-[44px]"
            >
              {bulkArchiving ? "Archiving..." : "Archive pre-2026"}
            </button>
          )}

          {/* Scope toggle */}
          {data?.canViewAll && (
            <div className="flex rounded-lg border border-brand-gray/30 overflow-hidden text-sm">
              <button
                onClick={() => switchScope("mine")}
                className={`px-4 py-2 min-h-[44px] font-semibold transition-colors ${
                  scope === "mine"
                    ? "bg-brand-blue text-white"
                    : "text-brand-gray hover:bg-brand-linen"
                }`}
              >
                My Pipeline
              </button>
              <button
                onClick={() => switchScope("all")}
                className={`px-4 py-2 min-h-[44px] font-semibold transition-colors border-l border-brand-gray/30 ${
                  scope === "all"
                    ? "bg-brand-blue text-white"
                    : "text-brand-gray hover:bg-brand-linen"
                }`}
              >
                All Staff
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Active / Archived tab — shown when in an individual pipeline view */}
      {!isStaffGrid && (
        <div className="flex gap-1 border-b border-brand-gray/15">
          <button
            onClick={() => setShowArchived(false)}
            className={`px-4 py-2 text-sm font-semibold border-b-2 -mb-px transition-colors ${
              showArchived
                ? "border-transparent text-brand-gray hover:text-brand-black"
                : "border-brand-blue text-brand-blue"
            }`}
          >
            Active
          </button>
          <button
            onClick={() => setShowArchived(true)}
            className={`px-4 py-2 text-sm font-semibold border-b-2 -mb-px transition-colors ${
              showArchived
                ? "border-brand-blue text-brand-blue"
                : "border-transparent text-brand-gray hover:text-brand-black"
            }`}
          >
            Archived
          </button>
        </div>
      )}

      {/* Summary bar */}
      {data && !loading && !showArchived && (
        <div className="flex flex-wrap gap-6 text-sm">
          <div>
            <p className="text-brand-gray text-xs uppercase tracking-wide">Pipeline value</p>
            <p className="text-brand-black font-semibold text-lg">
              {currency(totalValue, { whole: true })}
            </p>
          </div>
          <div>
            <p className="text-brand-gray text-xs uppercase tracking-wide">
              {isStaffGrid ? "Total quotes" : "Open quotes"}
            </p>
            <p className="text-brand-black font-semibold text-lg">{totalQuotes}</p>
          </div>
          {totalOverdue > 0 && (
            <div>
              <p className="text-brand-gray text-xs uppercase tracking-wide">Needs attention</p>
              <p className="text-red-600 font-semibold text-lg">{totalOverdue}</p>
            </div>
          )}
          {totalLeads > 0 && (
            <div>
              <p className="text-brand-gray text-xs uppercase tracking-wide">Open leads</p>
              <p className="text-brand-gold font-semibold text-lg">{totalLeads}</p>
            </div>
          )}
        </div>
      )}

      {/* Rendered only once data loads, so saved filters never mismatch the server's HTML. */}
      {data && !isStaffGrid && !showArchived && (
        <PipelineFilterBar
          filters={filters}
          onChange={setFilters}
          storeOptions={storeFilterOptions(
            quotes.map((q) => q.storeLocation),
            filters.store,
          )}
          choices={data.profileChoices ?? DEFAULT_CLIENT_PROFILE_CHOICES}
          shownCount={visibleQuotes.length}
          totalCount={quotes.length}
        />
      )}

      {data && isStaffGrid && (
        <select
          aria-label="Filter staff by store"
          value={filters.store}
          onChange={(e) => setFilters({ ...filters, store: e.target.value })}
          className="w-52 rounded-lg border border-brand-gray/30 bg-white px-3 py-2 text-sm text-brand-black min-h-[44px]"
        >
          {storeFilterOptions(
            allSummaries.map((s) => s.storeLocation),
            filters.store,
          ).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}

      {loading && (
        <div className="text-brand-gray text-sm animate-pulse py-8 text-center">
          Loading pipeline...
        </div>
      )}

      {!loading && data && (
        <>
          {/* ── All-staff grid ──────────────────────────────────────────── */}
          {isStaffGrid && (
            <section className="space-y-3">
              {data.unassigned && <UnassignedCard unassigned={data.unassigned} />}
              {summaries.length === 0 ? (
                <p className="text-brand-gray text-sm text-center py-16">
                  No open quotes or leads across any staff.
                </p>
              ) : (
                summaries.map((s) => (
                  <StaffSummaryCard
                    key={s.id}
                    summary={s}
                    onClick={() => {
                      setViewingStaffId(s.id);
                      setViewingStaffName(s.displayName);
                    }}
                  />
                ))
              )}
            </section>
          )}

          {/* ── Archived quotes view ────────────────────────────────────── */}
          {!isStaffGrid && showArchived && (
            <section className="space-y-3">
              {quotes.length === 0 ? (
                <p className="text-brand-gray text-sm text-center py-16">No archived quotes.</p>
              ) : (
                <>
                  <p className="text-xs text-brand-gray">
                    {quotes.length} archived quote{quotes.length === 1 ? "" : "s"} — tap Restore to
                    return to active pipeline.
                  </p>
                  {quotes.map((q) => (
                    <QuoteCard
                      key={q.id}
                      quote={q}
                      isArchived
                      searchTerm={debouncedSearch}
                      onRestore={handleRestore}
                    />
                  ))}
                </>
              )}
            </section>
          )}

          {/* ── Active individual pipeline ──────────────────────────────── */}
          {!isStaffGrid && !showArchived && (
            <>
              {active.length > 0 && (
                <section className="space-y-3">
                  <h2 className="text-xs font-semibold text-brand-gray uppercase tracking-widest">
                    Active — {active.length} quote{active.length === 1 ? "" : "s"}
                  </h2>
                  {active.map(renderActiveCard)}
                </section>
              )}

              {attentionQuotes.length > 0 && (
                <section className="space-y-3">
                  <h2 className="text-xs font-semibold text-red-600 uppercase tracking-widest">
                    Needs Attention — {attentionQuotes.length} quote
                    {attentionQuotes.length === 1 ? "" : "s"} overdue
                  </h2>
                  {attentionQuotes.map(renderActiveCard)}
                </section>
              )}

              {leads.length > 0 && (
                <section className="space-y-3">
                  <h2 className="text-xs font-semibold text-brand-gold uppercase tracking-widest">
                    Leads — {leads.length}
                  </h2>
                  {leads.map((lead) => (
                    <LeadCard key={lead.id} lead={lead} />
                  ))}
                </section>
              )}

              {quotes.length > 0 && visibleQuotes.length === 0 && (
                <div className="text-center py-16 space-y-2">
                  <p className="text-brand-gray">No quotes match these filters.</p>
                  <button
                    onClick={() => setFilters({ ...DEFAULT_PIPELINE_FILTERS, sort: filters.sort })}
                    className="text-brand-blue hover:underline text-sm min-h-[44px] px-2"
                  >
                    Clear filters
                  </button>
                </div>
              )}

              {quotes.length === 0 && leads.length === 0 && (
                <div className="text-center py-16 space-y-2">
                  <p className="text-brand-gray">No open quotes or leads.</p>
                  {scope === "mine" && (
                    <Link
                      href="/app/sales/quotes/new"
                      className="text-brand-blue hover:underline text-sm"
                    >
                      Start a new quote →
                    </Link>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}

      {followUpTarget && (
        <LogContactModal
          salesOrderId={followUpTarget.id}
          customerId={followUpTarget.customer?.id}
          title={`${customerDisplayName(followUpTarget)} · ${followUpTarget.orderno}`}
          dateOnFile={followUpTarget.customer?.profile?.nextFollowUpDate ?? null}
          canSchedule={Boolean(followUpTarget.customer) && !followUpTarget.customer?.isCashSale}
          today={today}
          onClose={() => setFollowUpTarget(null)}
          onSaved={() => {
            setFollowUpTarget(null);
            setRefreshKey((k) => k + 1);
          }}
        />
      )}

      {noteTarget && (
        <ClientNoteModal
          customerId={noteTarget.customer?.id}
          salesOrderId={noteTarget.id}
          title={`${customerDisplayName(noteTarget)} · ${noteTarget.orderno}`}
          staysOnQuote={noteTarget.customer?.isCashSale}
          onClose={() => setNoteTarget(null)}
          onSaved={() => {
            setNoteTarget(null);
            setRefreshKey((k) => k + 1);
          }}
        />
      )}

      {clientInfoTarget?.customer && (
        <ClientInfoModal
          customerId={clientInfoTarget.customer.id}
          customerName={customerDisplayName(clientInfoTarget)}
          onClose={() => setClientInfoTarget(null)}
          onSaved={() => {
            setClientInfoTarget(null);
            setRefreshKey((k) => k + 1);
          }}
        />
      )}

      {archiveTarget && (
        <ArchiveModal
          quote={archiveTarget}
          onClose={() => setArchiveTarget(null)}
          onSaved={() => {
            setArchiveTarget(null);
            setRefreshKey((k) => k + 1);
          }}
          suggestions={buildArchiveSuggestions(archiveTarget, quotes)}
        />
      )}
    </div>
  );
}
