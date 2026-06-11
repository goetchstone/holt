// /app/src/components/commission/PayoutsTab.tsx
//
// Payouts workspace on the commission-tiers report page — a frozen ledger of
// what was paid out each pay period.
//
// ONE component, TWO views. The page renders <PayoutsTab view="drafts"> and
// <PayoutsTab view="locked"> as two separate tabs:
//
//   • view="drafts"  — the WORK surface. Generate a pay period → review →
//     Confirm & Lock or Save as draft. Below: the editable DRAFT payouts
//     (lockedAt == null). Confirm & Lock moves the row to the Locked tab
//     (onAfterLock switches the page there so it doesn't just "vanish").
//   • view="locked"  — the ARCHIVE. Read-only list of LOCKED payouts
//     (lockedAt != null) + the DriftBanner (locked rows whose YTD shifted).
//     Corrections still go through the edit drawer (audit reason required).
//
// Flow kept deliberately simple: one pay-period dropdown (raw dates behind a
// "Custom range" toggle), one primary "Confirm & Lock" button, per-row
// overrides hidden until "Adjust", inline Draft-vs-Locked help. Each payout
// row expands to its tier breakdown + audit history; Edit opens the
// audit-reason drawer. Every payout carries the commission plan it was
// computed under (commissionPlanName — null on rows predating plans).

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  recentPayPeriods,
  formatPeriodLabel,
  formatPeriodDate,
  type PayPeriod,
} from "@/lib/payPeriod";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { getErrorMessage } from "@/lib/toastError";

interface BreakdownEntry {
  tierLabel: string;
  rate: number;
  sliceAmount: number;
  sliceCommission: number;
}

interface PreviewedPayout {
  staffMemberId: number;
  displayName: string;
  periodStart: string;
  periodEnd: string;
  periodSalesAmount: number;
  ytdSalesAtStart: number;
  ytdSalesAtEnd: number;
  tierBreakdown: BreakdownEntry[];
  commissionAmount: number;
  commissionPlanName: string;
}

/** Shape of one conflicting payout returned by the preview / 409 commit. */
interface OverlapRow {
  payoutId: number;
  staffMemberId: number;
  staffMemberDisplayName: string;
  periodStart: string;
  periodEnd: string;
  lockedAt: string | null;
}

interface StoredEdit {
  id: number;
  fieldChanged: string;
  oldValue: unknown;
  newValue: unknown;
  reason: string;
  editedBy: string;
  editedAt: string;
}

interface StoredPayout {
  id: number;
  staffMemberId: number;
  staffMember: { id: number; displayName: string };
  periodStart: string;
  periodEnd: string;
  periodSalesAmount: string | number;
  ytdSalesAtStart: string | number;
  ytdSalesAtEnd: string | number;
  tierBreakdown: BreakdownEntry[];
  commissionAmount: string | number;
  commissionPlanName: string | null;
  lockedAt: string | null;
  lockedBy: string | null;
  paidOn: string | null;
  notes: string | null;
  edits?: StoredEdit[];
}

/** Prisma Decimal fields arrive as strings over JSON — coerce for display. */
function toNum(n: number | string): number {
  return typeof n === "string" ? Number(n) : n;
}

// Period boundaries are UTC-midnight dates; render them in UTC so the local
// timezone never shifts a boundary back a day.
function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { timeZone: "UTC" });
}

// Most recent bi-weekly pay period that has already ended — the one you'd
// normally be paying out now. Falls back to the current (in-progress) period if
// none have ended yet. Drives the default Generate range so the operator lands
// on a set pay-period week instead of an arbitrary date span.
function defaultPayoutPeriod(): PayPeriod {
  const periods = recentPayPeriods(new Date(), 3);
  return periods.find((p) => p.end.getTime() < Date.now()) ?? periods[0];
}

/**
 * `view` selects which half of the payout workspace this instance is:
 * "drafts" shows the generate/preview workflow + editable draft rows;
 * "locked" shows the frozen archive + drift banner. `onAfterLock` lets the
 * drafts view ask the page to switch to the Locked tab once a row locks, so a
 * just-locked payout doesn't appear to vanish from the (drafts-only) list.
 */
export function PayoutsTab({
  view,
  onAfterLock,
}: Readonly<{ view: "drafts" | "locked"; onAfterLock?: () => void }>) {
  const [startDate, setStartDate] = useState(() => formatPeriodDate(defaultPayoutPeriod().start));
  const [endDate, setEndDate] = useState(() => formatPeriodDate(defaultPayoutPeriod().end));
  // The set bi-weekly pay periods, newest first. Selecting one fills the
  // start/end pickers below; the pickers stay editable for an off-cycle range
  // (e.g. a year-end true-up), in which case the selector shows "Custom range".
  const payPeriods = useMemo(() => recentPayPeriods(new Date(), 12), []);
  const selectedPeriodKey =
    payPeriods.find(
      (p) => formatPeriodDate(p.start) === startDate && formatPeriodDate(p.end) === endDate,
    ) !== undefined
      ? startDate
      : "custom";
  function selectPeriod(startIso: string) {
    const p = payPeriods.find((pp) => formatPeriodDate(pp.start) === startIso);
    if (p) {
      setStartDate(formatPeriodDate(p.start));
      setEndDate(formatPeriodDate(p.end));
    }
  }
  // The two free date pickers are an off-cycle escape hatch (year-end
  // true-ups), hidden by default so the common case is one dropdown.
  const [showCustomRange, setShowCustomRange] = useState(false);
  function toggleCustomRange() {
    setShowCustomRange((prev) => {
      const next = !prev;
      // Leaving custom mode on an off-cycle span snaps back to a set period
      // so the dropdown isn't stranded on "Custom range".
      if (!next && selectedPeriodKey === "custom") {
        const d = defaultPayoutPeriod();
        setStartDate(formatPeriodDate(d.start));
        setEndDate(formatPeriodDate(d.end));
      }
      return next;
    });
  }
  const [previewing, setPreviewing] = useState(false);
  const [previewRows, setPreviewRows] = useState<PreviewedPayout[]>([]);
  const [overlappingPayouts, setOverlappingPayouts] = useState<OverlapRow[]>([]);
  const [overrides, setOverrides] = useState<
    Record<number, { commissionAmount?: number; notes?: string }>
  >({});
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [payouts, setPayouts] = useState<StoredPayout[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [editingPayout, setEditingPayout] = useState<StoredPayout | null>(null);

  // One fetch returns locked + drafts; each view shows only its half.
  const visiblePayouts = useMemo(
    () => payouts.filter((p) => (view === "locked" ? p.lockedAt !== null : p.lockedAt === null)),
    [payouts, view],
  );

  const loadPayouts = useCallback(() => {
    setLoadingList(true);
    fetch("/api/admin/reports/commission-payouts?includeDrafts=true")
      .then((r) => r.json())
      .then((d) => setPayouts(d.payouts ?? []))
      .catch(() => setPayouts([]))
      .finally(() => setLoadingList(false));
  }, []);

  /**
   * Open the edit modal for a payout we don't currently have in
   * memory (e.g. the drift banner links by id). Fetches the row,
   * then sets editingPayout.
   */
  const loadPayoutAndOpenEditor = useCallback(async (payoutId: number) => {
    try {
      const res = await fetch(`/api/admin/reports/commission-payouts/${payoutId}`);
      const data = await res.json();
      if (res.ok && data.payout) {
        setEditingPayout(data.payout);
      }
    } catch {
      // swallow — the edit modal needs full row data; if the fetch
      // fails the operator can find the row in the table instead.
    }
  }, []);

  useEffect(() => {
    loadPayouts();
  }, [loadPayouts]);

  async function handlePreview() {
    setError(null);
    setPreviewing(true);
    setPreviewRows([]);
    setOverlappingPayouts([]);
    setOverrides({});
    try {
      const res = await fetch("/api/admin/reports/commission-payouts?action=preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startDate, endDate }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `HTTP ${res.status}`);
        setPreviewing(false);
        return;
      }
      setPreviewRows(data.payouts ?? []);
      setOverlappingPayouts(data.overlappingPayouts ?? []);
    } catch (err: unknown) {
      setError(getErrorMessage(err, "Failed to preview payouts"));
      setPreviewing(false);
    }
  }

  async function handleCommit(lockNow: boolean) {
    setCommitting(true);
    setError(null);
    try {
      const overrideList = Object.entries(overrides).map(([id, ov]) => ({
        staffMemberId: Number(id),
        commissionAmount: ov.commissionAmount,
        notes: ov.notes,
      }));
      const res = await fetch("/api/admin/reports/commission-payouts?action=commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startDate,
          endDate,
          overrides: overrideList,
          lockNow,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        // 409 = overlap conflict. Surface the structured overlap list
        // so the operator sees which rows collide, not just a toast.
        if (res.status === 409 && Array.isArray(data.overlappingPayouts)) {
          setOverlappingPayouts(data.overlappingPayouts);
        }
        setError(data.error || `HTTP ${res.status}`);
        return;
      }
      setPreviewing(false);
      setPreviewRows([]);
      setOverlappingPayouts([]);
      setOverrides({});
      loadPayouts();
      // A locked row leaves the drafts list — hand off to the Locked tab so it
      // doesn't appear to vanish. Drafts stay put on this (drafts) view.
      if (lockNow) onAfterLock?.();
    } catch (err: unknown) {
      setError(getErrorMessage(err, "Failed to commit payouts"));
    } finally {
      setCommitting(false);
    }
  }

  function closePreview() {
    setPreviewing(false);
    setPreviewRows([]);
    setOverlappingPayouts([]);
    setOverrides({});
    setError(null);
  }

  return (
    <div className="space-y-6">
      {view === "drafts" && (
        <>
          {/* Generate banner */}
          <section className="rounded border border-sh-stripe bg-white p-4">
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label htmlFor="payout-period" className="block text-xs font-medium text-sh-navy">
                  Pay period
                </label>
                <select
                  id="payout-period"
                  value={selectedPeriodKey}
                  onChange={(e) => selectPeriod(e.target.value)}
                  className="mt-1 rounded border border-gray-300 px-3 py-2 text-sm"
                >
                  {selectedPeriodKey === "custom" && <option value="custom">Custom range</option>}
                  {payPeriods.map((p) => (
                    <option key={p.index} value={formatPeriodDate(p.start)}>
                      {formatPeriodLabel(p)}
                    </option>
                  ))}
                </select>
              </div>
              {showCustomRange && (
                <>
                  <div>
                    <label
                      htmlFor="payout-start"
                      className="block text-xs font-medium text-sh-navy"
                    >
                      Period Start
                    </label>
                    <input
                      id="payout-start"
                      type="date"
                      value={startDate}
                      onChange={(e) => setStartDate(e.target.value)}
                      className="mt-1 rounded border border-gray-300 px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label htmlFor="payout-end" className="block text-xs font-medium text-sh-navy">
                      Period End
                    </label>
                    <input
                      id="payout-end"
                      type="date"
                      value={endDate}
                      onChange={(e) => setEndDate(e.target.value)}
                      className="mt-1 rounded border border-gray-300 px-3 py-2 text-sm"
                    />
                  </div>
                </>
              )}
              <button
                type="button"
                onClick={handlePreview}
                className="rounded bg-sh-navy px-4 py-2 text-sm font-medium text-white hover:bg-sh-blue"
              >
                Generate payouts
              </button>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
              <button
                type="button"
                onClick={toggleCustomRange}
                className="text-xs text-sh-gold hover:underline"
              >
                {showCustomRange ? "Use a set pay period" : "Custom range…"}
              </button>
              <span className="text-xs text-sh-gray">
                Draft = edit anytime. Locked = set in stone (edits need a reason).
              </span>
            </div>
            {error && !previewing && <p className="mt-2 text-sm text-red-600">{error}</p>}
          </section>

          {/* Preview modal */}
          {previewing && (
            <PreviewPanel
              rows={previewRows}
              overrides={overrides}
              onOverride={(staffMemberId, patch) =>
                setOverrides((prev) => ({
                  ...prev,
                  [staffMemberId]: { ...prev[staffMemberId], ...patch },
                }))
              }
              onSaveDraft={() => handleCommit(false)}
              onSaveLock={() => handleCommit(true)}
              onCancel={closePreview}
              committing={committing}
              startDate={startDate}
              endDate={endDate}
              error={error}
              overlappingPayouts={overlappingPayouts}
            />
          )}
        </>
      )}

      {/* Drift surface — locked rows whose underlying YTD shifted AFTER they
          locked. Quiet when clean; loud when not. Locked view only. */}
      {view === "locked" && <DriftBanner onEditPayout={(id) => loadPayoutAndOpenEditor(id)} />}

      {/* This view's payouts — drafts (editable) or the locked archive. */}
      <section>
        <h2 className="mb-2 text-lg font-semibold text-sh-navy">
          {view === "locked" ? "Locked Payouts" : "Draft Payouts"}
        </h2>
        <PayoutHistory
          view={view}
          loadingList={loadingList}
          payouts={visiblePayouts}
          expandedId={expandedId}
          onToggle={(id) => setExpandedId(expandedId === id ? null : id)}
          onEdit={(p) => setEditingPayout(p)}
        />
      </section>

      {/* Edit modal */}
      {editingPayout && (
        <EditPayoutModal
          payout={editingPayout}
          onClose={() => setEditingPayout(null)}
          onSaved={() => {
            setEditingPayout(null);
            loadPayouts();
          }}
        />
      )}
    </div>
  );
}

/**
 * Payout history — handles loading / empty / table states. Extracted
 * from the parent to flatten a nested ternary (Sonar S3358) and to
 * keep the parent component focused on state coordination.
 */
function PayoutHistory({
  view,
  loadingList,
  payouts,
  expandedId,
  onToggle,
  onEdit,
}: Readonly<{
  view: "drafts" | "locked";
  loadingList: boolean;
  payouts: StoredPayout[];
  expandedId: number | null;
  onToggle: (id: number) => void;
  onEdit: (p: StoredPayout) => void;
}>) {
  if (loadingList) return <p className="text-sm text-sh-gray">Loading…</p>;
  if (payouts.length === 0) {
    return (
      <p className="text-sm text-sh-gray">
        {view === "locked"
          ? "No locked payouts yet. Lock a draft to file it here."
          : "No draft payouts. Generate a pay period above to start one."}
      </p>
    );
  }
  // The tab name already says Draft vs Locked, so the per-row Status badge is
  // dropped here (it only made sense in the old combined table).
  return (
    <div className="overflow-x-auto rounded border border-sh-stripe bg-white">
      <table className="min-w-full text-left text-sm">
        <thead className="bg-sh-linen text-sh-black">
          <tr>
            <th className="p-3 font-medium">Salesperson</th>
            <th className="p-3 font-medium">Period</th>
            <th className="p-3 font-medium text-right">Period Sales</th>
            <th className="p-3 font-medium text-right">YTD End</th>
            <th className="p-3 font-medium text-right">Commission</th>
            <th className="p-3 font-medium">Paid On</th>
            <th className="p-3"></th>
          </tr>
        </thead>
        <tbody>
          {payouts.map((p) => (
            <PayoutRow
              key={p.id}
              p={p}
              expanded={expandedId === p.id}
              onToggle={() => onToggle(p.id)}
              onEdit={() => onEdit(p)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components — kept in this file for proximity to their parent. Each is
// trimmed of business logic; the parent owns state.
// ---------------------------------------------------------------------------

interface PreviewPanelProps {
  rows: PreviewedPayout[];
  overrides: Record<number, { commissionAmount?: number; notes?: string }>;
  onOverride: (staffMemberId: number, patch: { commissionAmount?: number; notes?: string }) => void;
  onSaveDraft: () => void;
  onSaveLock: () => void;
  onCancel: () => void;
  committing: boolean;
  startDate: string;
  endDate: string;
  error: string | null;
  overlappingPayouts: OverlapRow[];
}

/**
 * Warning banner shown at the top of the preview panel when the
 * requested pay-period range collides with one or more existing
 * draft / locked payouts. Save buttons are disabled while this is
 * visible — the operator must pick a different range or delete /
 * unlock the conflicting row(s) first.
 */
function OverlapWarning({ overlaps }: Readonly<{ overlaps: OverlapRow[] }>) {
  return (
    <div className="mb-3 rounded border-2 border-red-300 bg-red-50 p-3">
      <p className="mb-2 text-sm font-semibold text-red-800">
        ⚠ This pay period overlaps {overlaps.length} existing payout
        {overlaps.length === 1 ? "" : "s"}.
      </p>
      <p className="mb-2 text-xs text-red-900">
        Pick a non-overlapping range, OR delete / unlock the rows below before re-generating.
      </p>
      <ul className="space-y-1 text-xs text-red-900">
        {overlaps.map((o) => (
          <li key={o.payoutId} className="font-mono">
            {o.periodStart.slice(0, 10)} – {o.periodEnd.slice(0, 10)} · {o.staffMemberDisplayName}{" "}
            <span className="font-sans font-medium">({o.lockedAt ? "LOCKED" : "draft"})</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PreviewPanel({
  rows,
  overrides,
  onOverride,
  onSaveDraft,
  onSaveLock,
  onCancel,
  committing,
  startDate,
  endDate,
  error,
  overlappingPayouts,
}: Readonly<PreviewPanelProps>) {
  const money = useMoneyFormatter();
  const totalCommission = rows.reduce(
    (sum, r) => sum + (overrides[r.staffMemberId]?.commissionAmount ?? r.commissionAmount),
    0,
  );
  const hasOverlap = overlappingPayouts.length > 0;

  // Overrides are the exception, not the rule — the computed numbers are
  // right almost every time. Hide the inputs until the operator clicks
  // "Adjust" on a row, so the default preview is a clean read-only table.
  const [editingRows, setEditingRows] = useState<ReadonlySet<number>>(() => new Set());
  function toggleRow(id: number) {
    setEditingRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <section className="rounded border border-sh-gold/40 bg-amber-50 p-4">
      <h3 className="mb-2 text-base font-semibold text-sh-navy">
        Preview — {startDate} to {endDate}
      </h3>
      {hasOverlap && <OverlapWarning overlaps={overlappingPayouts} />}
      {rows.length === 0 ? (
        <p className="text-sm text-sh-gray">Computing…</p>
      ) : (
        <>
          <div className="overflow-x-auto rounded bg-white">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-sh-linen text-sh-black">
                <tr>
                  <th className="p-2 font-medium">Salesperson</th>
                  <th className="p-2 font-medium">Plan</th>
                  <th className="p-2 font-medium text-right">Period Sales</th>
                  <th className="p-2 font-medium text-right">YTD End</th>
                  <th className="p-2 font-medium text-right">Commission</th>
                  <th className="p-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const ov = overrides[r.staffMemberId] ?? {};
                  const isAdjusted = ov.commissionAmount !== undefined || (ov.notes ?? "") !== "";
                  const isEditing = editingRows.has(r.staffMemberId) || isAdjusted;
                  const effective = ov.commissionAmount ?? r.commissionAmount;
                  return (
                    <Fragment key={r.staffMemberId}>
                      <tr className="border-t border-sh-stripe">
                        <td className="p-2">{r.displayName}</td>
                        <td className="p-2 text-sh-gray">{r.commissionPlanName}</td>
                        <td className="p-2 text-right tabular-nums">
                          {money(r.periodSalesAmount)}
                        </td>
                        <td className="p-2 text-right tabular-nums">{money(r.ytdSalesAtEnd)}</td>
                        <td className="p-2 text-right tabular-nums">
                          {money(effective)}
                          {ov.commissionAmount !== undefined && (
                            <span className="ml-1 text-xs font-medium text-sh-gold">adj.</span>
                          )}
                        </td>
                        <td className="p-2 text-right">
                          <button
                            type="button"
                            onClick={() => toggleRow(r.staffMemberId)}
                            className="text-xs text-sh-gold hover:underline"
                          >
                            {isEditing ? "Done" : "Adjust"}
                          </button>
                        </td>
                      </tr>
                      {isEditing && (
                        <tr className="border-t border-sh-stripe bg-white">
                          <td colSpan={6} className="px-2 pb-3">
                            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                              <span className="flex items-center gap-2">
                                <label
                                  htmlFor={`ov-amt-${r.staffMemberId}`}
                                  className="text-xs text-sh-gray"
                                >
                                  Override amount
                                </label>
                                <input
                                  id={`ov-amt-${r.staffMemberId}`}
                                  type="number"
                                  step={0.01}
                                  value={ov.commissionAmount ?? ""}
                                  placeholder={r.commissionAmount.toFixed(2)}
                                  onChange={(e) =>
                                    onOverride(r.staffMemberId, {
                                      commissionAmount:
                                        e.target.value === "" ? undefined : Number(e.target.value),
                                    })
                                  }
                                  className="w-28 rounded border border-gray-300 px-2 py-1 text-right text-xs"
                                />
                              </span>
                              <span className="flex flex-1 items-center gap-2">
                                <label
                                  htmlFor={`ov-note-${r.staffMemberId}`}
                                  className="text-xs text-sh-gray"
                                >
                                  Notes
                                </label>
                                <input
                                  id={`ov-note-${r.staffMemberId}`}
                                  type="text"
                                  value={ov.notes ?? ""}
                                  placeholder="optional"
                                  onChange={(e) =>
                                    onOverride(r.staffMemberId, { notes: e.target.value })
                                  }
                                  className="min-w-[12rem] flex-1 rounded border border-gray-300 px-2 py-1 text-xs"
                                />
                              </span>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
              <tfoot className="border-t border-sh-stripe bg-sh-stripe font-medium">
                <tr>
                  <td className="p-2">Total ({rows.length} salespeople)</td>
                  <td colSpan={3}></td>
                  <td colSpan={2} className="p-2 text-right tabular-nums">
                    {money(totalCommission)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
          <p className="mt-3 text-xs text-sh-gray">
            Confirm &amp; Lock sets this pay period in stone — later edits need an audit reason. Not
            ready? Save it as a draft and keep editing.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-4">
            <button
              type="button"
              onClick={onSaveLock}
              disabled={committing || hasOverlap}
              title={hasOverlap ? "Resolve the overlapping payout(s) above first." : undefined}
              className="rounded bg-sh-navy px-5 py-2 text-sm font-medium text-white hover:bg-sh-blue disabled:cursor-not-allowed disabled:opacity-50"
            >
              {committing ? "Saving…" : "Confirm & Lock"}
            </button>
            <button
              type="button"
              onClick={onSaveDraft}
              disabled={committing || hasOverlap}
              title={hasOverlap ? "Resolve the overlapping payout(s) above first." : undefined}
              className="text-sm text-sh-gray underline hover:text-sh-navy disabled:cursor-not-allowed disabled:opacity-50"
            >
              {committing ? "Saving…" : "Save as draft instead"}
            </button>
            <button
              type="button"
              onClick={onCancel}
              disabled={committing}
              className="ml-auto text-sm text-sh-gray hover:underline disabled:cursor-not-allowed disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </section>
  );
}

interface PayoutRowProps {
  p: StoredPayout;
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
}

function PayoutRow({ p, expanded, onToggle, onEdit }: Readonly<PayoutRowProps>) {
  const money = useMoneyFormatter();
  return (
    <>
      <tr className="border-t border-sh-stripe hover:bg-sh-linen">
        <td className="p-3 font-medium text-sh-navy">{p.staffMember.displayName}</td>
        <td className="p-3 whitespace-nowrap text-sh-gray">
          {formatDate(p.periodStart)} – {formatDate(p.periodEnd)}
        </td>
        <td className="p-3 text-right tabular-nums">{money(toNum(p.periodSalesAmount))}</td>
        <td className="p-3 text-right tabular-nums">{money(toNum(p.ytdSalesAtEnd))}</td>
        <td className="p-3 text-right tabular-nums font-medium">
          {money(toNum(p.commissionAmount))}
        </td>
        <td className="p-3 whitespace-nowrap text-sh-gray">{formatDate(p.paidOn)}</td>
        <td className="p-3 whitespace-nowrap">
          <button
            type="button"
            onClick={onToggle}
            className="mr-2 text-xs text-sh-gold hover:underline"
          >
            {expanded ? "Hide" : "Detail"}
          </button>
          <button type="button" onClick={onEdit} className="text-xs text-sh-gold hover:underline">
            Edit
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="border-t border-sh-stripe bg-sh-linen/30">
          <td colSpan={7} className="p-4">
            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <h4 className="mb-2 text-xs font-semibold uppercase text-sh-gray">
                  Tier Breakdown
                </h4>
                <p className="mb-2 text-xs text-sh-gray">
                  Plan:{" "}
                  <span className="font-medium text-sh-navy">{p.commissionPlanName ?? "—"}</span>
                </p>
                <table className="min-w-full text-xs">
                  <thead>
                    <tr className="text-sh-gray">
                      <th className="py-1 text-left">Tier</th>
                      <th className="py-1 text-right">Rate</th>
                      <th className="py-1 text-right">Slice</th>
                      <th className="py-1 text-right">Comm.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.tierBreakdown.map((b, i) => (
                      <tr key={`${b.tierLabel}-${i}`}>
                        <td className="py-1">{b.tierLabel}</td>
                        <td className="py-1 text-right">{(b.rate * 100).toFixed(1)}%</td>
                        <td className="py-1 text-right tabular-nums">{money(b.sliceAmount)}</td>
                        <td className="py-1 text-right tabular-nums">{money(b.sliceCommission)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {p.notes && (
                  <div className="mt-3">
                    <div className="text-xs font-semibold uppercase text-sh-gray">Notes</div>
                    <p className="text-sm">{p.notes}</p>
                  </div>
                )}
              </div>
              <div>
                <h4 className="mb-2 text-xs font-semibold uppercase text-sh-gray">Edit History</h4>
                {p.edits && p.edits.length > 0 ? (
                  <ul className="space-y-2">
                    {p.edits.map((e) => (
                      <li
                        key={e.id}
                        className="rounded border border-sh-stripe bg-white p-2 text-xs"
                      >
                        <div className="text-sh-navy font-medium">
                          {e.fieldChanged} · {e.editedBy}
                        </div>
                        <div className="text-sh-gray">{new Date(e.editedAt).toLocaleString()}</div>
                        <div className="mt-1">
                          <span className="text-red-700">{JSON.stringify(e.oldValue)}</span>
                          {" → "}
                          <span className="text-green-700">{JSON.stringify(e.newValue)}</span>
                        </div>
                        <div className="mt-1 italic text-sh-gray">{e.reason}</div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-sh-gray">No edits.</p>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

interface EditPayoutModalProps {
  payout: StoredPayout;
  onClose: () => void;
  onSaved: () => void;
}

function EditPayoutModal({ payout, onClose, onSaved }: Readonly<EditPayoutModalProps>) {
  const [commissionAmount, setCommissionAmount] = useState(String(payout.commissionAmount));
  const [notes, setNotes] = useState(payout.notes ?? "");
  const [paidOn, setPaidOn] = useState(payout.paidOn ? payout.paidOn.slice(0, 10) : "");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isLocked = !!payout.lockedAt;

  async function save() {
    setError(null);
    if (!reason.trim()) {
      setError("Audit reason is required.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/reports/commission-payouts/${payout.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: reason.trim(),
          commissionAmount: Number(commissionAmount),
          notes: notes || null,
          paidOn: paidOn || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `HTTP ${res.status}`);
        return;
      }
      onSaved();
    } catch (err: unknown) {
      setError(getErrorMessage(err, "Failed to save"));
    } finally {
      setSaving(false);
    }
  }

  async function toggleLock() {
    setError(null);
    if (!reason.trim()) {
      setError("Audit reason is required to lock or unlock.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/reports/commission-payouts/${payout.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: reason.trim(),
          lockedAt: isLocked ? null : new Date().toISOString(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `HTTP ${res.status}`);
        return;
      }
      onSaved();
    } catch (err: unknown) {
      setError(getErrorMessage(err, "Failed to update lock"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl">
        <h3 className="text-lg font-semibold text-sh-navy">
          Edit Payout — {payout.staffMember.displayName}
        </h3>
        <p className="mt-1 text-xs text-sh-gray">
          Period {formatDate(payout.periodStart)} – {formatDate(payout.periodEnd)}
          {isLocked ? " · Currently LOCKED" : " · Draft"}
        </p>

        <div className="mt-4 space-y-3">
          <div>
            <label htmlFor="edit-commission" className="block text-xs font-medium text-sh-navy">
              Commission Amount
            </label>
            <input
              id="edit-commission"
              type="number"
              step={0.01}
              value={commissionAmount}
              onChange={(e) => setCommissionAmount(e.target.value)}
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label htmlFor="edit-paid-on" className="block text-xs font-medium text-sh-navy">
              Paid On
            </label>
            <input
              id="edit-paid-on"
              type="date"
              value={paidOn}
              onChange={(e) => setPaidOn(e.target.value)}
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label htmlFor="edit-notes" className="block text-xs font-medium text-sh-navy">
              Notes
            </label>
            <textarea
              id="edit-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label htmlFor="edit-reason" className="block text-xs font-medium text-sh-navy">
              Audit Reason <span className="text-red-600">*</span>
            </label>
            <input
              id="edit-reason"
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this edit needed?"
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
            />
            <p className="mt-1 text-xs text-sh-gray">
              Required for every change. Recorded in the audit log.
            </p>
          </div>
        </div>

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded border border-gray-300 px-4 py-2 text-sm text-sh-gray hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={toggleLock}
            disabled={saving}
            className="rounded border border-amber-400 px-4 py-2 text-sm text-amber-800 hover:bg-amber-50"
          >
            {isLocked ? "Unlock" : "Lock"}
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="rounded bg-sh-navy px-4 py-2 text-sm font-medium text-white hover:bg-sh-blue"
          >
            {saving ? "Saving…" : "Save with Audit"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drift banner — surfaces locked payouts whose underlying YTD data has
// shifted (returns / rewrites / cancellations / reassignments landing
// after the lock). Quiet box when clean; loud red list when not.
// ---------------------------------------------------------------------------

interface DriftRow {
  payoutId: number;
  staffMemberId: number;
  displayName: string;
  periodStart: string;
  periodEnd: string;
  lockedYtdAtEnd: number;
  liveYtdAtEnd: number;
  drift: number;
  lockedCommissionAmount: number;
  lockedAt: string;
  lockedBy: string | null;
}

function DriftBanner({ onEditPayout }: Readonly<{ onEditPayout: (payoutId: number) => void }>) {
  const money = useMoneyFormatter();
  const [rows, setRows] = useState<DriftRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch("/api/admin/reports/commission-payouts/drift")
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setRows(d.rows ?? []);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return null;
  if (rows.length === 0) return null; // quiet when nothing's drifted

  return (
    <section className="rounded border-2 border-red-300 bg-red-50 p-4">
      <h2 className="mb-2 text-base font-semibold text-red-800">Payout Drift ({rows.length})</h2>
      <p className="mb-3 text-xs text-red-900">
        These locked payouts had returns, rewrites, cancellations, or salesperson reassignments land
        AFTER they locked. The commission already paid no longer matches the underlying YTD. Edit
        each row (with an audit reason) to claw back, or accept the variance — the next pay
        period&apos;s YTD-at-start uses the frozen YTD-at-end from these rows, so the chain stays
        continuous either way.
      </p>
      <div className="overflow-x-auto rounded border border-red-200 bg-white">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-red-100 text-red-900">
            <tr>
              <th className="p-2 font-medium">Salesperson</th>
              <th className="p-2 font-medium">Period</th>
              <th className="p-2 font-medium text-right">Locked YTD End</th>
              <th className="p-2 font-medium text-right">Live YTD End</th>
              <th className="p-2 font-medium text-right">Drift</th>
              <th className="p-2 font-medium text-right">Paid Commission</th>
              <th className="p-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.payoutId} className="border-t border-red-100">
                <td className="p-2">{r.displayName}</td>
                <td className="p-2 text-xs">
                  {formatDate(r.periodStart)} – {formatDate(r.periodEnd)}
                </td>
                <td className="p-2 text-right tabular-nums">{money(r.lockedYtdAtEnd)}</td>
                <td className="p-2 text-right tabular-nums">{money(r.liveYtdAtEnd)}</td>
                <td
                  className={`p-2 text-right tabular-nums font-medium ${r.drift < 0 ? "text-red-700" : "text-amber-700"}`}
                >
                  {r.drift > 0 ? "+" : ""}
                  {money(r.drift)}
                </td>
                <td className="p-2 text-right tabular-nums">{money(r.lockedCommissionAmount)}</td>
                <td className="p-2">
                  <button
                    type="button"
                    onClick={() => onEditPayout(r.payoutId)}
                    className="rounded border border-red-300 px-2 py-1 text-xs font-medium text-red-800 hover:bg-red-100"
                  >
                    Review / Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
