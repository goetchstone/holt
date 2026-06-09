"use client";

// /app/src/app/(dashboard)/app/reports/pipeline-opportunity/PipelineOpportunityView.tsx
//
// Pipeline Opportunity client view. List + per-salesperson quote drilldown via
// tRPC; reassign + add-note stay REST POST mutations (shared endpoints kept
// during the migration). After a successful reassign or note, the list query is
// refetched so totals + rows reflect the change.

import React, { useState } from "react";
import axios from "axios";
import Link from "next/link";
import { toast } from "react-toastify";
import { ChevronDown, ChevronRight } from "lucide-react";
import { KpiCard, ReportSection } from "@/components/report";
import { Button } from "@/components/ui/button";
import { LeadScoreBadge } from "@/components/customer/LeadScoreBadge";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { api } from "@/lib/trpc/client";
import { getErrorMessage } from "@/lib/toastError";
import type { PipelineQuoteRow } from "@/lib/reports/pipelineOpportunity";

// Truncated single-line note preview for the drilldown table cell.
function notePreview(note: string | null): string {
  if (!note) return "—";
  return note.length > 30 ? note.substring(0, 30) + "..." : note;
}

export function PipelineOpportunityView() {
  const money = useMoneyFormatter();
  const currency = (v: number) => money(v, { whole: true });
  const utils = api.useUtils();

  const [includeInactive, setIncludeInactive] = useState(false);
  const [includeArchived, setIncludeArchived] = useState(false);

  const pipelineQuery = api.reports.pipelineOpportunity.useQuery({
    includeInactive,
    includeArchived,
  });
  const data = pipelineQuery.data;
  const loading = pipelineQuery.isFetching && !data;

  // Drilldown state
  const [expandedSp, setExpandedSp] = useState<string | null>(null);
  const [detailRows, setDetailRows] = useState<PipelineQuoteRow[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [expandedQuote, setExpandedQuote] = useState<number | null>(null);

  // Note state
  const [noteOrderId, setNoteOrderId] = useState<number | null>(null);
  const [noteText, setNoteText] = useState("");
  const [noteSaving, setNoteSaving] = useState(false);

  // Reassign state
  const [reassignFrom, setReassignFrom] = useState<string | null>(null);
  const [reassignTo, setReassignTo] = useState("");
  const [reassigning, setReassigning] = useState(false);

  async function loadDetail(salesperson: string) {
    setDetailLoading(true);
    try {
      const detail = await utils.reports.pipelineDetail.fetch({
        salesperson,
        includeArchived,
      });
      setDetailRows(detail.rows);
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to load quotes"));
      setDetailRows([]);
    } finally {
      setDetailLoading(false);
    }
  }

  async function handleExpandSp(salesperson: string) {
    if (expandedSp === salesperson) {
      setExpandedSp(null);
      setDetailRows([]);
      return;
    }
    setExpandedSp(salesperson);
    setExpandedQuote(null);
    await loadDetail(salesperson);
  }

  async function handleAddNote(orderId: number, customerId: number | null) {
    if (!noteText.trim()) return;
    setNoteSaving(true);
    try {
      await axios.post("/api/sales/interactions", {
        salesOrderId: orderId,
        customerId,
        source: "MANAGER_NOTE",
        notes: noteText.trim(),
      });
      toast.success("Note added");
      setNoteText("");
      setNoteOrderId(null);
      // Refresh the drilldown to show the new note
      if (expandedSp) await loadDetail(expandedSp);
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to add note"));
    } finally {
      setNoteSaving(false);
    }
  }

  async function handleReassign() {
    if (!reassignFrom || !reassignTo) return;
    setReassigning(true);
    try {
      const { data: result } = await axios.post("/api/reports/pipeline-reassign", {
        fromSalesperson: reassignFrom,
        toStaffId: Number(reassignTo),
      });
      toast.success(`Reassigned ${result.reassigned} quotes/orders to ${result.toSalesperson}`);
      setReassignFrom(null);
      setReassignTo("");
      setExpandedSp(null);
      await pipelineQuery.refetch();
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to reassign"));
    } finally {
      setReassigning(false);
    }
  }

  const inactiveRows = data?.rows.filter((r) => !r.isActive) ?? [];

  return (
    <div className="space-y-6 font-serif">
      <nav className="text-sm text-sh-gray">
        <Link href="/app/reports" className="hover:underline">
          Reports
        </Link>
        <span className="mx-2">/</span>
        <span className="text-sh-black">Pipeline Opportunity</span>
      </nav>
      <h1 className="text-2xl font-semibold text-sh-navy">Pipeline Opportunity</h1>
      <p className="text-sm text-sh-gray">
        Open quotes by salesperson. Click a name to see their individual quotes.
      </p>

      {data && (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <KpiCard label="Pipeline Value" value={currency(data.totals.totalPipeline)} />
            <KpiCard label="Open Quotes" value={data.totals.totalQuotes} />
            <KpiCard label="Converted (12mo)" value={data.totals.totalConverted} />
            <KpiCard label="Avg Conversion" value={`${data.totals.avgConversion}%`} />
          </div>

          <div className="flex items-center gap-4">
            <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-sm text-sh-gray">
              <input
                type="checkbox"
                checked={includeInactive}
                onChange={(e) => setIncludeInactive(e.target.checked)}
                className="h-5 w-5 accent-sh-blue"
              />
              Show inactive employees
            </label>
            <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-sm text-sh-gray">
              <input
                type="checkbox"
                checked={includeArchived}
                onChange={(e) => setIncludeArchived(e.target.checked)}
                className="h-5 w-5 accent-sh-blue"
              />
              Include archived quotes
            </label>
            {includeInactive && inactiveRows.length > 0 && (
              <span className="text-xs text-amber-600">
                {inactiveRows.length} inactive with open pipeline
              </span>
            )}
          </div>

          {/* Salesperson rows with expandable drilldown */}
          <ReportSection
            title="Pipeline by Salesperson"
            description="Click a name to expand their quotes"
          >
            <div className="space-y-1">
              {data.rows.map((row) => (
                <div key={row.salesperson}>
                  <button
                    type="button"
                    onClick={() => handleExpandSp(row.salesperson)}
                    className={`flex min-h-[44px] w-full items-center gap-3 rounded-lg px-4 py-3 text-left transition ${
                      expandedSp === row.salesperson
                        ? "border border-sh-blue/20 bg-sh-blue/5"
                        : "border border-sh-gray/10 bg-white hover:border-sh-gray/30"
                    }`}
                  >
                    {expandedSp === row.salesperson ? (
                      <ChevronDown className="h-4 w-4 flex-shrink-0 text-sh-gray" />
                    ) : (
                      <ChevronRight className="h-4 w-4 flex-shrink-0 text-sh-gray" />
                    )}
                    <span className="flex-1 font-semibold text-sh-navy">
                      {row.salesperson}
                      {!row.isActive && (
                        <span className="ml-1 font-normal text-amber-600">(inactive)</span>
                      )}
                    </span>
                    <span className="text-sm text-sh-gray">{row.openQuotes} quotes</span>
                    <span className="min-w-[100px] text-right text-sm font-semibold text-sh-navy">
                      {currency(row.openQuoteValue)}
                    </span>
                    <span className="min-w-[60px] text-right text-xs text-sh-gray">
                      {row.conversionPct}% conv
                    </span>
                    <span className="min-w-[50px] text-right text-xs text-sh-gray">
                      {row.avgQuoteAgeDays ?? 0}d avg
                    </span>
                  </button>

                  {expandedSp === row.salesperson && (
                    <div className="mb-4 ml-7 mt-2">
                      {detailLoading && (
                        <p className="py-4 text-sm text-sh-gray">Loading quotes...</p>
                      )}
                      {!detailLoading && detailRows.length === 0 && (
                        <p className="py-4 text-sm text-sh-gray">No open quotes</p>
                      )}
                      {!detailLoading && detailRows.length > 0 && (
                        <>
                          <div className="overflow-hidden rounded-xl border border-sh-gray/15 bg-white">
                            <table className="w-full text-sm">
                              <thead>
                                <tr className="border-b border-sh-gray/15 bg-sh-linen">
                                  <th className="px-4 py-2 text-left text-xs font-semibold uppercase text-sh-gray">
                                    Quote
                                  </th>
                                  <th className="px-4 py-2 text-left text-xs font-semibold uppercase text-sh-gray">
                                    Customer
                                  </th>
                                  <th className="px-4 py-2 text-left text-xs font-semibold uppercase text-sh-gray">
                                    Date
                                  </th>
                                  <th className="px-4 py-2 text-right text-xs font-semibold uppercase text-sh-gray">
                                    Age
                                  </th>
                                  <th className="px-4 py-2 text-right text-xs font-semibold uppercase text-sh-gray">
                                    Value
                                  </th>
                                  <th className="px-4 py-2 text-right text-xs font-semibold uppercase text-sh-gray">
                                    Items
                                  </th>
                                  <th className="px-4 py-2 text-left text-xs font-semibold uppercase text-sh-gray">
                                    Contact
                                  </th>
                                  <th className="px-4 py-2 text-left text-xs font-semibold uppercase text-sh-gray">
                                    Note
                                  </th>
                                </tr>
                              </thead>
                              <tbody>
                                {detailRows.map((q, qi) => (
                                  <React.Fragment key={q.id}>
                                    <tr
                                      className={`cursor-pointer border-b border-sh-gray/10 transition hover:bg-sh-linen ${qi % 2 === 1 ? "bg-sh-stripe" : ""}`}
                                      onClick={() =>
                                        setExpandedQuote(expandedQuote === q.id ? null : q.id)
                                      }
                                    >
                                      <td className="px-4 py-2">
                                        <Link
                                          href={`/app/sales/orders/${q.id}`}
                                          className="text-sh-blue hover:underline"
                                          onClick={(e) => e.stopPropagation()}
                                        >
                                          {q.orderno}
                                        </Link>
                                      </td>
                                      <td className="px-4 py-2">
                                        <div className="flex flex-wrap items-center gap-2">
                                          {q.customerId ? (
                                            <Link
                                              href={`/app/sales/customers/${q.customerId}`}
                                              className="text-sh-blue hover:underline"
                                              onClick={(e) => e.stopPropagation()}
                                            >
                                              {q.customerName}
                                            </Link>
                                          ) : (
                                            <span>{q.customerName}</span>
                                          )}
                                          <LeadScoreBadge tier={q.leadTier} score={q.leadScore} />
                                        </div>
                                      </td>
                                      <td className="px-4 py-2 text-sh-gray">
                                        {q.quoteDate ?? "—"}
                                      </td>
                                      <td className="px-4 py-2 text-right">{q.ageDays ?? 0}d</td>
                                      <td className="px-4 py-2 text-right font-medium">
                                        {currency(q.quoteValue)}
                                      </td>
                                      <td className="px-4 py-2 text-right text-sh-gray">
                                        <span className="inline-flex items-center gap-1">
                                          {q.lineItemCount}
                                          {expandedQuote === q.id ? (
                                            <ChevronDown className="h-3 w-3" />
                                          ) : (
                                            <ChevronRight className="h-3 w-3" />
                                          )}
                                        </span>
                                      </td>
                                      <td className="px-4 py-2 text-xs text-sh-gray">
                                        {q.lastInteraction ?? "None"}
                                      </td>
                                      <td className="px-4 py-2 text-xs text-sh-gray">
                                        {notePreview(q.lastNote)}
                                      </td>
                                    </tr>
                                    {expandedQuote === q.id && q.lineItems.length > 0 && (
                                      <tr>
                                        <td colSpan={8} className="bg-sh-linen/50 px-4 py-2">
                                          <table className="ml-4 w-full text-xs">
                                            <thead>
                                              <tr className="text-sh-gray">
                                                <th className="py-1 text-left font-medium">Item</th>
                                                <th className="py-1 text-left font-medium">
                                                  Part #
                                                </th>
                                                <th className="py-1 text-right font-medium">Qty</th>
                                                <th className="py-1 text-right font-medium">
                                                  Price
                                                </th>
                                                <th className="py-1 text-right font-medium">
                                                  Total
                                                </th>
                                              </tr>
                                            </thead>
                                            <tbody>
                                              {q.lineItems.map((li) => (
                                                <tr
                                                  key={li.id}
                                                  className="border-t border-sh-gray/10"
                                                >
                                                  <td className="py-1 text-sh-black">
                                                    {li.productName || "—"}
                                                  </td>
                                                  <td className="py-1 text-sh-gray">
                                                    {li.partNo || "—"}
                                                  </td>
                                                  <td className="py-1 text-right">{li.quantity}</td>
                                                  <td className="py-1 text-right">
                                                    {currency(li.unitPrice)}
                                                  </td>
                                                  <td className="py-1 text-right font-medium">
                                                    {currency(li.lineTotal)}
                                                  </td>
                                                </tr>
                                              ))}
                                            </tbody>
                                          </table>
                                        </td>
                                      </tr>
                                    )}
                                  </React.Fragment>
                                ))}
                              </tbody>
                            </table>
                          </div>

                          {/* Inline note form */}
                          <div className="mt-3 space-y-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <label className="text-xs font-semibold uppercase tracking-wider text-sh-gray">
                                Add note to quote:
                              </label>
                              <select
                                value={noteOrderId ?? ""}
                                onChange={(e) =>
                                  setNoteOrderId(e.target.value ? Number(e.target.value) : null)
                                }
                                className="min-h-[44px] rounded border border-sh-gray/30 px-2 py-1 text-sm"
                              >
                                <option value="">Select quote...</option>
                                {detailRows.map((q) => (
                                  <option key={q.id} value={q.id}>
                                    {q.orderno} — {q.customerName} ({currency(q.quoteValue)})
                                  </option>
                                ))}
                              </select>
                            </div>
                            {noteOrderId && (
                              <div className="flex gap-2">
                                <input
                                  type="text"
                                  value={noteText}
                                  onChange={(e) => setNoteText(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" && noteText.trim()) {
                                      const q = detailRows.find((r) => r.id === noteOrderId);
                                      handleAddNote(noteOrderId, q?.customerId ?? null);
                                    }
                                  }}
                                  placeholder="Type a note and press Enter..."
                                  className="min-h-[44px] flex-1 rounded border border-sh-gray/30 px-3 py-2 text-sm"
                                />
                                <Button
                                  size="sm"
                                  onClick={() => {
                                    const q = detailRows.find((r) => r.id === noteOrderId);
                                    handleAddNote(noteOrderId, q?.customerId ?? null);
                                  }}
                                  disabled={!noteText.trim() || noteSaving}
                                  className="min-h-[44px]"
                                >
                                  {noteSaving ? "Saving..." : "Add Note"}
                                </Button>
                              </div>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </ReportSection>

          {/* Reassign panel */}
          {includeInactive && inactiveRows.length > 0 && (
            <div className="space-y-3 rounded-xl border border-amber-200 bg-white p-5">
              <h3 className="text-sm font-semibold text-sh-navy">Reassign Inactive Pipeline</h3>
              <p className="text-xs text-sh-gray">
                Move all open quotes and orders from an inactive salesperson to an active one.
              </p>
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-sh-gray">
                    From (inactive)
                  </label>
                  <select
                    value={reassignFrom || ""}
                    onChange={(e) => setReassignFrom(e.target.value || null)}
                    className="min-h-[44px] rounded-lg border border-sh-gray/30 px-3 py-2 text-sm"
                  >
                    <option value="">Select...</option>
                    {inactiveRows.map((r) => (
                      <option key={r.salesperson} value={r.salesperson}>
                        {r.salesperson} ({r.openQuotes} quotes, {currency(r.openQuoteValue)})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-sh-gray">
                    To (active)
                  </label>
                  <select
                    value={reassignTo}
                    onChange={(e) => setReassignTo(e.target.value)}
                    className="min-h-[44px] rounded-lg border border-sh-gray/30 px-3 py-2 text-sm"
                  >
                    <option value="">Select...</option>
                    {(data.activeSalespeople || []).map((sp) => (
                      <option key={sp.id} value={sp.id}>
                        {sp.displayName}
                      </option>
                    ))}
                  </select>
                </div>
                <Button
                  onClick={handleReassign}
                  disabled={!reassignFrom || !reassignTo || reassigning}
                  className="min-h-[44px]"
                >
                  {reassigning ? "Reassigning..." : "Reassign"}
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {loading && <p className="py-16 text-center text-sh-gray">Loading...</p>}
    </div>
  );
}
