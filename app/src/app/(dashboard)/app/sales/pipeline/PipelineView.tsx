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
import { useEffectiveRole } from "@/lib/hooks/useEffectiveRole";
import { ARCHIVE_REASONS, REPLACEMENT_REASONS } from "@/lib/quoteArchive";
import { getErrorMessage } from "@/lib/toastError";

type ContactSource = "WALK_IN" | "PHONE" | "EMAIL" | "APPOINTMENT";

const SOURCE_LABELS: Record<ContactSource, string> = {
  PHONE: "Phone",
  EMAIL: "Email",
  WALK_IN: "In-store",
  APPOINTMENT: "Appointment",
};

function urgencyClass(daysSinceContact: number | null, daysSinceCreated: number) {
  const days = daysSinceContact ?? daysSinceCreated;
  if (days > 14) return { dot: "bg-red-500", badge: "bg-red-50 text-red-700 border-red-200" };
  if (days > 7)
    return { dot: "bg-amber-500", badge: "bg-amber-50 text-amber-700 border-amber-200" };
  if (days > 3)
    return { dot: "bg-yellow-400", badge: "bg-yellow-50 text-yellow-700 border-yellow-200" };
  return { dot: "bg-green-500", badge: "bg-green-50 text-green-700 border-green-200" };
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

// ── Follow-up modal ──────────────────────────────────────────────────────────

function FollowUpModal({
  quote,
  onClose,
  onSaved,
}: Readonly<{
  quote: PipelineQuote;
  onClose: () => void;
  onSaved: () => void;
}>) {
  const [source, setSource] = useState<ContactSource>("PHONE");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await axios.post("/api/sales/interactions", {
        salesOrderId: quote.id,
        customerId: quote.customer?.id,
        source,
        notes: notes.trim() || undefined,
      });
      toast.success("Follow-up logged.");
      onSaved();
    } catch {
      toast.error("Failed to log follow-up.");
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
            <h2 className="text-lg font-semibold text-sh-black font-serif">Log Follow-Up</h2>
            <p className="text-sm text-sh-gray mt-0.5">
              {quote.customer ? customerDisplayName(quote) : "Unknown customer"} · {quote.orderno}
            </p>
          </div>

          <div>
            <p className="text-xs text-sh-gray uppercase tracking-wide mb-2">
              How you reached them
            </p>
            <div className="grid grid-cols-4 gap-2">
              {(Object.keys(SOURCE_LABELS) as ContactSource[]).map((s) => (
                <button
                  key={s}
                  onClick={() => setSource(s)}
                  className={`py-2 px-1 rounded-lg border text-xs font-semibold transition-colors min-h-[44px] ${
                    source === s
                      ? "bg-sh-blue text-white border-sh-blue"
                      : "border-sh-gray/30 text-sh-gray hover:border-sh-blue"
                  }`}
                >
                  {SOURCE_LABELS[s]}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label
              htmlFor="follow-up-notes"
              className="block text-xs text-sh-gray uppercase tracking-wide mb-2"
            >
              Notes <span className="normal-case">(optional)</span>
            </label>
            <textarea
              id="follow-up-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Left voicemail about fabric selections..."
              className="w-full border border-sh-gray/30 rounded-lg px-3 py-2 text-sm text-sh-black resize-none focus:outline-none focus:ring-1 focus:ring-sh-blue"
            />
          </div>

          <div className="flex gap-3 pt-1">
            <Button onClick={handleSave} disabled={saving} className="flex-1 min-h-[44px]">
              {saving ? "Saving..." : "Log Follow-Up"}
            </Button>
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-sh-gray/30 text-sh-gray text-sm min-h-[44px]"
            >
              Cancel
            </button>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
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
            <h2 className="text-lg font-semibold text-sh-black font-serif">Archive Quote</h2>
            <p className="text-sm text-sh-gray mt-0.5">
              {quote.customer ? customerDisplayName(quote) : "Unknown customer"} · {quote.orderno} ·{" "}
              {currency(quote.totalAmount, { whole: true })}
            </p>
          </div>

          <div>
            <p className="text-xs text-sh-gray uppercase tracking-wide mb-2">Reason</p>
            <div className="flex flex-wrap gap-2 mb-3">
              {ARCHIVE_REASONS.map((r) => (
                <button
                  key={r}
                  onClick={() => setReason(reason === r ? "" : r)}
                  className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                    reason === r
                      ? "bg-sh-blue text-white border-sh-blue"
                      : "border-sh-gray/30 text-sh-gray hover:border-sh-blue"
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>

          {needsReplacement && (
            <div>
              <p className="text-xs text-sh-gray uppercase tracking-wide mb-2">
                Replaced by which quote?
              </p>
              {suggestions.length === 0 ? (
                <p className="text-sm text-sh-gray italic">
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
                  className="w-full border border-sh-gray/30 rounded-lg px-3 py-2 text-sm text-sh-black focus:outline-none focus:ring-1 focus:ring-sh-blue min-h-[44px]"
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
              className="block text-xs text-sh-gray uppercase tracking-wide mb-2"
            >
              Note (optional)
            </label>
            <textarea
              id="archive-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="Add context for the archive..."
              className="w-full border border-sh-gray/30 rounded-lg px-3 py-2 text-sm text-sh-black resize-none focus:outline-none focus:ring-1 focus:ring-sh-blue"
            />
          </div>

          <div className="flex gap-3 pt-1">
            <Button
              onClick={handleArchive}
              disabled={saving}
              className="flex-1 min-h-[44px] bg-sh-gray hover:bg-sh-black"
            >
              {saving ? "Archiving..." : "Archive Quote"}
            </Button>
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-sh-gray/30 text-sh-gray text-sm min-h-[44px]"
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
  onArchive,
  onRestore,
  isArchived,
}: Readonly<{
  quote: PipelineQuote;
  onFollowUp?: (q: PipelineQuote) => void;
  onArchive?: (q: PipelineQuote) => void;
  onRestore?: (q: PipelineQuote) => void;
  isArchived?: boolean;
}>) {
  const currency = useMoneyFormatter();
  const { effectiveRole } = useEffectiveRole();
  const [showHistory, setShowHistory] = useState(false);
  const urgency = urgencyClass(quote.daysSinceContact, quote.daysSinceCreated);
  const customerName = quote.customer
    ? `${quote.customer.firstName ?? ""} ${quote.customer.lastName ?? ""}`.trim() || "No name"
    : "No customer";
  const urgencyDays = quote.daysSinceContact ?? quote.daysSinceCreated ?? 0;
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
          ? "border-sh-gray/10 opacity-75"
          : "border-sh-gray/15 hover:border-sh-blue/30 hover:shadow-md"
      } transition-all`}
    >
      <div className="flex flex-col items-center pt-1 gap-2 shrink-0">
        <div className={`w-2.5 h-2.5 rounded-full ${isArchived ? "bg-sh-gray/40" : urgency.dot}`} />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <p className="font-semibold text-sh-black text-base leading-tight truncate">
                {customerName}
              </p>
              <LeadScoreBadge tier={quote.customer?.leadTier} score={quote.customer?.leadScore} />
              {canSeeWealth && <WealthTierBadge tier={quote.customer?.wealthTier} />}
            </div>
            <p className="text-xs text-sh-gray mt-0.5">
              <span className="text-sh-blue">{quote.orderno}</span>
              {quote.storeLocation && ` · ${quote.storeLocation}`}
              {quote.salesperson && ` · ${quote.salesperson}`}
              {quote.quoteDate && ` · ${formatQuoteDate(quote.quoteDate)}`}
            </p>
          </div>
          <div className="text-right shrink-0">
            <p className="font-semibold text-sh-black">
              {currency(quote.totalAmount, { whole: true })}
            </p>
            {!isArchived && (
              <span
                className={`inline-block text-xs font-semibold px-2 py-0.5 rounded-full border mt-1 ${urgency.badge}`}
              >
                {urgencyDays === 0 ? "Today" : `${urgencyDays}d`}
              </span>
            )}
          </div>
        </div>

        <p className="text-xs text-sh-gray mt-2 truncate">{quote.lineItemSummary}</p>

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
          <p className="text-xs text-sh-blue mt-1.5">
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
          <p className="text-xs text-sh-gray mt-1">Reason: {quote.archiveReason}</p>
        )}

        {isArchived && quote.pipelineNote && (
          <p className="text-xs text-sh-gray mt-1 italic">{quote.pipelineNote}</p>
        )}

        <div className="flex items-center justify-between mt-3 gap-2">
          {isArchived ? (
            <p className="text-xs text-sh-gray">
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
              className={`text-xs text-left ${quote.lastInteractionAt ? "text-sh-gray hover:text-sh-blue" : "text-amber-600 font-medium"}`}
            >
              {quote.lastInteractionAt
                ? lastContactLabel(quote.daysSinceContact ?? 0, quote.interactions.length)
                : "No follow-up yet"}
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
                className="text-xs font-semibold text-sh-blue border border-sh-blue/40 rounded-lg px-3 py-1.5 hover:bg-sh-blue hover:text-white transition-colors min-h-[36px]"
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
                  className="text-xs text-sh-gray border border-sh-gray/30 rounded-lg px-3 py-1.5 hover:bg-sh-linen transition-colors min-h-[36px]"
                >
                  Archive
                </button>
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onFollowUp?.(quote);
                  }}
                  className="text-xs font-semibold text-sh-blue border border-sh-blue/40 rounded-lg px-3 py-1.5 hover:bg-sh-blue hover:text-white transition-colors min-h-[36px]"
                >
                  Follow Up
                </button>
              </>
            )}
          </div>
        </div>

        {showHistory && quote.interactions.length > 0 && (
          <div className="mt-3 pt-3 border-t border-sh-gray/10 space-y-2">
            {quote.interactions.map((ix) => (
              <div key={ix.id} className="flex gap-2 text-xs">
                <span className="text-sh-gray shrink-0 w-16">
                  {new Date(ix.startedAt).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  })}
                </span>
                <span className="shrink-0 px-1.5 py-0.5 rounded bg-sh-linen text-sh-gray font-medium">
                  {SOURCE_LABELS[ix.source as ContactSource] ?? ix.source}
                </span>
                <span className="text-sh-gray shrink-0">{ix.staffName}</span>
                {ix.notes && (
                  <span className="text-sh-black truncate" title={ix.notes}>
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
    <div className="bg-white rounded-xl border border-sh-gold/30 shadow-sm p-4 flex gap-4">
      <div className="flex flex-col items-center pt-1 gap-2 shrink-0">
        <div className="w-2.5 h-2.5 rounded-full bg-sh-gold" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="font-semibold text-sh-black text-base leading-tight">{name}</p>
            <p className="text-xs text-sh-gray mt-0.5">
              {sourceLabel[lead.source] ?? lead.source} · {lead.status}
            </p>
          </div>
          <span className="text-xs text-sh-gray shrink-0">{daysLabel(lead.daysSinceCreated)}</span>
        </div>
        {(lead.phone || lead.email) && (
          <p className="text-xs text-sh-gray mt-1.5">
            {lead.phone && <span>{lead.phone}</span>}
            {lead.phone && lead.email && " · "}
            {lead.email && <span>{lead.email}</span>}
          </p>
        )}
        {lead.notes && <p className="text-xs text-sh-gray mt-1 italic truncate">{lead.notes}</p>}
        {lead.salesOrderId && (
          <Link
            href={`/app/sales/orders/${lead.salesOrderId}`}
            className="text-xs text-sh-blue hover:underline mt-1 block"
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
      className="w-full text-left bg-white rounded-xl border border-sh-gray/15 shadow-sm p-4 hover:border-sh-blue/50 hover:shadow-md transition-all"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-sh-black text-base leading-tight truncate">
            {summary.displayName}
          </p>
          {summary.storeLocation && (
            <p className="text-xs text-sh-gray mt-0.5">{summary.storeLocation}</p>
          )}
        </div>
        {summary.overdueCount > 0 && (
          <span className="text-xs font-semibold bg-red-50 text-red-700 border border-red-200 px-2 py-0.5 rounded-full shrink-0 whitespace-nowrap">
            {summary.overdueCount} overdue
          </span>
        )}
      </div>
      <div className="flex gap-6 mt-4">
        <div>
          <p className="text-xs text-sh-gray uppercase tracking-wide">Pipeline</p>
          <p className="font-semibold text-sh-black text-lg">
            {currency(summary.totalValue, { whole: true })}
          </p>
        </div>
        <div>
          <p className="text-xs text-sh-gray uppercase tracking-wide">Quotes</p>
          <p className="font-semibold text-sh-black text-lg">{summary.quoteCount}</p>
        </div>
        {summary.leadCount > 0 && (
          <div>
            <p className="text-xs text-sh-gray uppercase tracking-wide">Leads</p>
            <p className="font-semibold text-sh-gold text-lg">{summary.leadCount}</p>
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
function buildPipelineUrl(
  scope: "mine" | "all",
  viewingStaffId: number | null,
  showArchived: boolean,
): string {
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
      totalOverdue: summaries.reduce((s, st) => s + st.overdueCount, 0),
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
  const [archiveTarget, setArchiveTarget] = useState<PipelineQuote | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [bulkArchiving, setBulkArchiving] = useState(false);

  const fetchPipeline = useCallback(async () => {
    setLoading(true);
    try {
      const url = buildPipelineUrl(scope, viewingStaffId, showArchived);
      const res = await axios.get<PipelineResponse>(url);
      setData(res.data);
    } catch {
      toast.error("Failed to load pipeline.");
    } finally {
      setLoading(false);
    }
  }, [scope, viewingStaffId, showArchived, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const isStaffGrid = scope === "all" && viewingStaffId === null;
  const quotes = data?.quotes ?? [];
  const leads = data?.leads ?? [];
  const summaries = data?.staffSummaries ?? [];

  // Active pipeline buckets
  const needsAttention = quotes.filter((q) => (q.daysSinceContact ?? q.daysSinceCreated) > 7);
  const active = quotes.filter((q) => (q.daysSinceContact ?? q.daysSinceCreated) <= 7);

  const { totalValue, totalQuotes, totalOverdue, totalLeads } = computeSummaryTotals({
    isStaffGrid,
    summaries,
    quotes,
    leads,
    needsAttention,
  });

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
              className="text-sh-blue text-sm hover:underline shrink-0"
            >
              ← All Staff
            </button>
          )}
          <h1 className="text-2xl font-semibold text-sh-blue truncate">{pageTitle}</h1>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          {/* Bulk archive — manager only, shown on active views */}
          {data?.canViewAll && !showArchived && !isStaffGrid && (
            <button
              onClick={handleBulkArchive}
              disabled={bulkArchiving}
              className="text-xs text-sh-gray border border-sh-gray/30 rounded-lg px-3 py-2 hover:bg-sh-linen transition-colors min-h-[44px]"
            >
              {bulkArchiving ? "Archiving..." : "Archive pre-2026"}
            </button>
          )}

          {/* Scope toggle */}
          {data?.canViewAll && (
            <div className="flex rounded-lg border border-sh-gray/30 overflow-hidden text-sm">
              <button
                onClick={() => switchScope("mine")}
                className={`px-4 py-2 min-h-[44px] font-semibold transition-colors ${
                  scope === "mine" ? "bg-sh-blue text-white" : "text-sh-gray hover:bg-sh-linen"
                }`}
              >
                My Pipeline
              </button>
              <button
                onClick={() => switchScope("all")}
                className={`px-4 py-2 min-h-[44px] font-semibold transition-colors border-l border-sh-gray/30 ${
                  scope === "all" ? "bg-sh-blue text-white" : "text-sh-gray hover:bg-sh-linen"
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
        <div className="flex gap-1 border-b border-sh-gray/15">
          <button
            onClick={() => setShowArchived(false)}
            className={`px-4 py-2 text-sm font-semibold border-b-2 -mb-px transition-colors ${
              showArchived
                ? "border-transparent text-sh-gray hover:text-sh-black"
                : "border-sh-blue text-sh-blue"
            }`}
          >
            Active
          </button>
          <button
            onClick={() => setShowArchived(true)}
            className={`px-4 py-2 text-sm font-semibold border-b-2 -mb-px transition-colors ${
              showArchived
                ? "border-sh-blue text-sh-blue"
                : "border-transparent text-sh-gray hover:text-sh-black"
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
            <p className="text-sh-gray text-xs uppercase tracking-wide">Pipeline value</p>
            <p className="text-sh-black font-semibold text-lg">
              {currency(totalValue, { whole: true })}
            </p>
          </div>
          <div>
            <p className="text-sh-gray text-xs uppercase tracking-wide">
              {isStaffGrid ? "Total quotes" : "Open quotes"}
            </p>
            <p className="text-sh-black font-semibold text-lg">{totalQuotes}</p>
          </div>
          {totalOverdue > 0 && (
            <div>
              <p className="text-sh-gray text-xs uppercase tracking-wide">Overdue</p>
              <p className="text-red-600 font-semibold text-lg">{totalOverdue}</p>
            </div>
          )}
          {totalLeads > 0 && (
            <div>
              <p className="text-sh-gray text-xs uppercase tracking-wide">Open leads</p>
              <p className="text-sh-gold font-semibold text-lg">{totalLeads}</p>
            </div>
          )}
        </div>
      )}

      {loading && (
        <div className="text-sh-gray text-sm animate-pulse py-8 text-center">
          Loading pipeline...
        </div>
      )}

      {!loading && data && (
        <>
          {/* ── All-staff grid ──────────────────────────────────────────── */}
          {isStaffGrid && (
            <section className="space-y-3">
              {summaries.length === 0 ? (
                <p className="text-sh-gray text-sm text-center py-16">
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
                <p className="text-sh-gray text-sm text-center py-16">No archived quotes.</p>
              ) : (
                <>
                  <p className="text-xs text-sh-gray">
                    {quotes.length} archived quote{quotes.length === 1 ? "" : "s"} — tap Restore to
                    return to active pipeline.
                  </p>
                  {quotes.map((q) => (
                    <QuoteCard key={q.id} quote={q} isArchived onRestore={handleRestore} />
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
                  <h2 className="text-xs font-semibold text-sh-gray uppercase tracking-widest">
                    Active — {active.length} quote{active.length === 1 ? "" : "s"}
                  </h2>
                  {active.map((q) => (
                    <QuoteCard
                      key={q.id}
                      quote={q}
                      onFollowUp={setFollowUpTarget}
                      onArchive={setArchiveTarget}
                    />
                  ))}
                </section>
              )}

              {needsAttention.length > 0 && (
                <section className="space-y-3">
                  <h2 className="text-xs font-semibold text-red-600 uppercase tracking-widest">
                    Needs Attention — {needsAttention.length} quote
                    {needsAttention.length === 1 ? "" : "s"} overdue
                  </h2>
                  {needsAttention.map((q) => (
                    <QuoteCard
                      key={q.id}
                      quote={q}
                      onFollowUp={setFollowUpTarget}
                      onArchive={setArchiveTarget}
                    />
                  ))}
                </section>
              )}

              {leads.length > 0 && (
                <section className="space-y-3">
                  <h2 className="text-xs font-semibold text-sh-gold uppercase tracking-widest">
                    Leads — {leads.length}
                  </h2>
                  {leads.map((lead) => (
                    <LeadCard key={lead.id} lead={lead} />
                  ))}
                </section>
              )}

              {quotes.length === 0 && leads.length === 0 && (
                <div className="text-center py-16 space-y-2">
                  <p className="text-sh-gray">No open quotes or leads.</p>
                  {scope === "mine" && (
                    <Link
                      href="/app/sales/quotes/new"
                      className="text-sh-blue hover:underline text-sm"
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
        <FollowUpModal
          quote={followUpTarget}
          onClose={() => setFollowUpTarget(null)}
          onSaved={() => {
            setFollowUpTarget(null);
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
