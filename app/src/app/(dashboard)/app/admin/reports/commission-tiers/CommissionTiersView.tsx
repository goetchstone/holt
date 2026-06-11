"use client";

// /app/src/app/(dashboard)/app/admin/reports/commission-tiers/CommissionTiersView.tsx
//
// Commission report body (SUPER_ADMIN only — page gate in page.tsx). Three
// tabs:
//   • Draft Payouts (DEFAULT) — the work surface: pick a SET bi-weekly pay
//     period, Generate → Confirm & Lock (files it under Locked Payouts) or
//     Save as draft (stays editable here). This is where payouts get made.
//   • Locked Payouts — the frozen archive of what's been paid, read-only except
//     for edit-with-audit corrections. Also surfaces the drift banner.
//   • Live Calculator — secondary what-if: marginal-tier commission for any
//     custom date window (defaults YTD), per-plan attribution, and the
//     commission-plans manager (create / edit tiers / set default / delete).
//     Does NOT pay anyone.
// Both Draft + Locked render the SAME <PayoutsTab view=…> component. Talks to
// the shared /api/admin/reports/commission-tiers REST endpoints.

import { useCallback, useEffect, useState } from "react";
import { PayoutsTab } from "@/components/commission/PayoutsTab";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { getErrorMessage } from "@/lib/toastError";

type Tab = "drafts" | "locked" | "calculator";

interface Breakdown {
  tierLabel: string;
  rate: number;
  salesInTier: number;
  commission: number;
}

interface CommissionRow {
  staffId: number;
  displayName: string;
  ytdAtStart: number;
  windowSales: number;
  ytdAtEnd: number;
  currentTierLabel: string;
  commission: number;
  breakdown: Breakdown[];
  /** Name of the commission plan this row's tiers resolved from. */
  planName: string;
}

interface ReportData {
  startDate: string;
  endDate: string;
  asOf: string;
  rows: CommissionRow[];
  totals: { totalWindowSales: number; totalCommission: number };
}

/** One tier row inside a plan, as returned by the tiers endpoint. */
interface PlanTierRow {
  label: string;
  minYtdSales: number;
  maxYtdSalesExclusive: number | null;
  rate: number;
  sortOrder: number;
}

interface Plan {
  id: number;
  name: string;
  description: string | null;
  isDefault: boolean;
  isActive: boolean;
  assignedCount: number;
  tiers: PlanTierRow[];
}

/**
 * Draft variant of a tier for the inline editor. The `_draftId` is a synthetic
 * stable identifier used as the React `key` on each editor row -- using the
 * array index there would make rows lose focus when a middle row is removed
 * (S6479). The id is stripped from the payload before saving since the API + DB
 * model have no such column.
 */
interface DraftTier {
  _draftId: string;
  label: string;
  minYtdSales: number;
  maxYtdSalesExclusive: number | null;
  rate: number;
}

let draftIdSeq = 0;
function nextDraftId(): string {
  draftIdSeq += 1;
  return `draft-${draftIdSeq}`;
}

function formatPct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`.replace(".0%", "%");
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function yearStartIso(): string {
  return `${new Date().getUTCFullYear()}-01-01`;
}

export function CommissionTiersView() {
  const [data, setData] = useState<ReportData | null>(null);
  const [startDate, setStartDate] = useState<string>(yearStartIso());
  const [endDate, setEndDate] = useState<string>(todayIso());
  const [loading, setLoading] = useState(true);
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  // Default to the Drafts workspace (generate a past period → review →
  // confirm/lock). Locked Payouts is the frozen archive; Live Calculator is the
  // secondary "what-if any date range" tool.
  const [activeTab, setActiveTab] = useState<Tab>("drafts");

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/admin/reports/commission-tiers?startDate=${startDate}&endDate=${endDate}`)
      .then((r) => r.json())
      .then((d) => setData(d))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [startDate, endDate]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <div className="mb-4 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <strong>Owner-confidential.</strong> SUPER_ADMIN only. Tier rates are not for distribution
        to staff. Direct-URL access only -- not linked from any hub page.
      </div>

      {/* Tabs — Drafts is the work surface (default); Locked Payouts is the
          frozen archive; Live Calculator is the secondary what-if. */}
      <div className="mb-1 flex gap-1 border-b border-sh-stripe">
        <TabButton active={activeTab === "drafts"} onClick={() => setActiveTab("drafts")}>
          Draft Payouts
        </TabButton>
        <TabButton active={activeTab === "locked"} onClick={() => setActiveTab("locked")}>
          Locked Payouts
        </TabButton>
        <TabButton active={activeTab === "calculator"} onClick={() => setActiveTab("calculator")}>
          Live Calculator
        </TabButton>
      </div>

      {activeTab === "drafts" && (
        <p className="mb-4 text-xs text-sh-gray">
          Pick a pay period → <strong>Generate</strong> → review →{" "}
          <strong>Confirm &amp; Lock</strong> (files it under <strong>Locked Payouts</strong>) or{" "}
          <strong>Save as draft</strong> to keep editing here. Drafts can be changed anytime; a
          locked payout is set in stone.
        </p>
      )}
      {activeTab === "locked" && (
        <p className="mb-4 text-xs text-sh-gray">
          The frozen record of what was paid each pay period. Read-only — to correct a locked
          payout, open it and <strong>Edit</strong> (an audit reason is required for every change).
        </p>
      )}
      {activeTab === "calculator" && (
        <p className="mb-4 text-xs text-sh-gray">
          What-if calculator for any date range — current marginal-tier commission as the data
          stands now. It does not pay anyone; use <strong>Draft Payouts</strong> to confirm + lock.
        </p>
      )}

      {activeTab === "drafts" && (
        <PayoutsTab view="drafts" onAfterLock={() => setActiveTab("locked")} />
      )}
      {activeTab === "locked" && <PayoutsTab view="locked" />}
      {activeTab === "calculator" && (
        <>
          <DateRangeControls
            startDate={startDate}
            endDate={endDate}
            setStartDate={setStartDate}
            setEndDate={setEndDate}
          />

          <PlansManager onPlansChanged={load} />

          {data && !loading && (
            <>
              <TotalsCards totals={data.totals} />
              <DesignerTable
                rows={data.rows}
                expandedRow={expandedRow}
                setExpandedRow={setExpandedRow}
              />
            </>
          )}
          {loading && <div className="text-sh-gray">Loading...</div>}
        </>
      )}
    </div>
  );
}

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

function TabButton({ active, onClick, children }: Readonly<TabButtonProps>) {
  const stateClass = active
    ? "border-sh-navy text-sh-navy"
    : "border-transparent text-sh-gray hover:text-sh-black";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition ${stateClass}`}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Plans manager — list plans, edit a plan's tier rows inline, create / set
// default / delete. Self-contained: owns its own fetch + state; the parent
// passes onPlansChanged so the calculator below recomputes after a save.
// ---------------------------------------------------------------------------

/** Why the Delete button is disabled for this plan, or null when allowed. */
function deleteBlockedReason(plan: Plan): string | null {
  if (plan.isDefault) {
    return "The default plan cannot be deleted — make another plan the default first.";
  }
  if (plan.assignedCount > 0) {
    return `${plan.assignedCount} staff member${plan.assignedCount === 1 ? " is" : "s are"} assigned to this plan — reassign them first.`;
  }
  return null;
}

function PlansManager({ onPlansChanged }: Readonly<{ onPlansChanged: () => void }>) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loadingPlans, setLoadingPlans] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);

  // Inline tier editor for ONE plan at a time.
  const [editingPlanId, setEditingPlanId] = useState<number | null>(null);
  const [tierDraft, setTierDraft] = useState<DraftTier[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Inline "new plan" mini-form.
  const [showNewPlan, setShowNewPlan] = useState(false);
  const [newPlanName, setNewPlanName] = useState("");
  const [busy, setBusy] = useState(false);

  const loadPlans = useCallback(() => {
    setLoadingPlans(true);
    fetch("/api/admin/reports/commission-tiers/tiers")
      .then((r) => r.json())
      .then((d) => setPlans(d.plans ?? []))
      .catch(() => setPlans([]))
      .finally(() => setLoadingPlans(false));
  }, []);

  useEffect(() => {
    loadPlans();
  }, [loadPlans]);

  function beginEditPlan(plan: Plan) {
    setTierDraft(plan.tiers.map((t) => ({ ...t, _draftId: nextDraftId() })));
    setEditingPlanId(plan.id);
    setSaveError(null);
  }

  function cancelEditTiers() {
    setEditingPlanId(null);
    setTierDraft([]);
    setSaveError(null);
  }

  async function saveTiers() {
    if (editingPlanId === null) return;
    setSaveError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/admin/reports/commission-tiers/tiers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // Strip the synthetic _draftId -- API + DB model don't carry it.
        body: JSON.stringify({
          planId: editingPlanId,
          tiers: tierDraft.map((t, i) => ({
            label: t.label,
            minYtdSales: t.minYtdSales,
            maxYtdSalesExclusive: t.maxYtdSalesExclusive,
            rate: t.rate,
            sortOrder: i,
          })),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Unknown error" }));
        setSaveError(body.error || `HTTP ${res.status}`);
        return;
      }
      cancelEditTiers();
      loadPlans();
      onPlansChanged();
    } catch (err: unknown) {
      setSaveError(getErrorMessage(err, "Failed to save tiers"));
    } finally {
      setBusy(false);
    }
  }

  async function createPlan() {
    const name = newPlanName.trim();
    if (!name) {
      setActionError("Plan name is required.");
      return;
    }
    setActionError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/admin/reports/commission-tiers/tiers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Unknown error" }));
        setActionError(body.error || `HTTP ${res.status}`);
        return;
      }
      setShowNewPlan(false);
      setNewPlanName("");
      loadPlans();
      onPlansChanged();
    } catch (err: unknown) {
      setActionError(getErrorMessage(err, "Failed to create plan"));
    } finally {
      setBusy(false);
    }
  }

  async function makeDefault(planId: number) {
    setActionError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/admin/reports/commission-tiers/tiers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId, action: "setDefault" }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Unknown error" }));
        setActionError(body.error || `HTTP ${res.status}`);
        return;
      }
      loadPlans();
      onPlansChanged();
    } catch (err: unknown) {
      setActionError(getErrorMessage(err, "Failed to set default plan"));
    } finally {
      setBusy(false);
    }
  }

  async function deletePlan(plan: Plan) {
    if (!window.confirm(`Delete plan "${plan.name}"? This cannot be undone.`)) return;
    setActionError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/admin/reports/commission-tiers/tiers", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: plan.id }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Unknown error" }));
        setActionError(body.error || `HTTP ${res.status}`);
        return;
      }
      if (editingPlanId === plan.id) cancelEditTiers();
      loadPlans();
      onPlansChanged();
    } catch (err: unknown) {
      setActionError(getErrorMessage(err, "Failed to delete plan"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-6">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-sh-navy">Commission Plans</h2>
        {showNewPlan ? (
          <div className="flex items-center gap-2">
            <label htmlFor="new-plan-name" className="sr-only">
              New plan name
            </label>
            <input
              id="new-plan-name"
              type="text"
              value={newPlanName}
              onChange={(e) => setNewPlanName(e.target.value)}
              placeholder="Plan name"
              className="rounded border border-gray-300 px-3 py-1 text-sm"
            />
            <button
              type="button"
              onClick={createPlan}
              disabled={busy}
              className="rounded bg-sh-navy px-3 py-1 text-sm text-white hover:bg-sh-blue disabled:cursor-not-allowed disabled:opacity-50"
            >
              Create
            </button>
            <button
              type="button"
              onClick={() => {
                setShowNewPlan(false);
                setNewPlanName("");
                setActionError(null);
              }}
              disabled={busy}
              className="rounded border border-gray-300 px-3 py-1 text-sm text-sh-gray hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowNewPlan(true)}
            className="rounded border border-sh-navy px-3 py-1 text-sm text-sh-navy hover:bg-sh-linen"
          >
            + New Plan
          </button>
        )}
      </div>

      {actionError && (
        <div className="mb-2 rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-900">
          {actionError}
        </div>
      )}

      {loadingPlans && <p className="text-sm text-sh-gray">Loading plans…</p>}
      {!loadingPlans && plans.length === 0 && (
        <p className="rounded border border-gray-200 bg-white p-3 text-sm text-sh-gray">
          No plans yet — payouts fall back to the standard tier set. Create a plan to manage tiers
          here (the first plan becomes the default automatically).
        </p>
      )}

      <div className="space-y-3">
        {plans.map((plan) => (
          <PlanCard
            key={plan.id}
            plan={plan}
            editing={editingPlanId === plan.id}
            tierDraft={tierDraft}
            saveError={saveError}
            busy={busy}
            onBeginEdit={() => beginEditPlan(plan)}
            onCancelEdit={cancelEditTiers}
            onSaveTiers={saveTiers}
            onUpdateDraftTier={(i, patch) =>
              setTierDraft((prev) => prev.map((t, idx) => (idx === i ? { ...t, ...patch } : t)))
            }
            onAddTier={() =>
              setTierDraft((prev) => {
                const last = prev.at(-1);
                const newMin = last?.maxYtdSalesExclusive ?? 0;
                // Close out the previous "open-ended" tier with an upper bound.
                const updated = prev.map((t, i) =>
                  i === prev.length - 1 && t.maxYtdSalesExclusive === null
                    ? { ...t, maxYtdSalesExclusive: newMin + 500_000 }
                    : t,
                );
                return [
                  ...updated,
                  {
                    _draftId: nextDraftId(),
                    label: "New Tier",
                    minYtdSales: newMin,
                    maxYtdSalesExclusive: null,
                    rate: 0.05,
                  },
                ];
              })
            }
            onRemoveTier={(i) => setTierDraft((prev) => prev.filter((_, idx) => idx !== i))}
            onMakeDefault={() => makeDefault(plan.id)}
            onDelete={() => deletePlan(plan)}
          />
        ))}
      </div>

      <p className="mt-2 text-xs text-sh-gray">
        Marginal: each tier&apos;s rate applies only to the slice of YTD sales inside that
        tier&apos;s bracket. Tiers are not retroactive -- once a salesperson crosses a threshold,
        subsequent sales earn the higher rate going forward. Staff without an assigned plan use the
        default plan.
      </p>
    </section>
  );
}

interface PlanCardProps {
  plan: Plan;
  editing: boolean;
  tierDraft: DraftTier[];
  saveError: string | null;
  busy: boolean;
  onBeginEdit: () => void;
  onCancelEdit: () => void;
  onSaveTiers: () => void;
  onUpdateDraftTier: (i: number, patch: Partial<DraftTier>) => void;
  onAddTier: () => void;
  onRemoveTier: (i: number) => void;
  onMakeDefault: () => void;
  onDelete: () => void;
}

function PlanCard({
  plan,
  editing,
  tierDraft,
  saveError,
  busy,
  onBeginEdit,
  onCancelEdit,
  onSaveTiers,
  onUpdateDraftTier,
  onAddTier,
  onRemoveTier,
  onMakeDefault,
  onDelete,
}: Readonly<PlanCardProps>) {
  const blocked = deleteBlockedReason(plan);
  return (
    <div className="rounded border border-gray-200 bg-white p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-sh-navy">{plan.name}</span>
          {plan.isDefault && (
            <span className="rounded bg-sh-navy px-2 py-0.5 text-xs text-white">Default</span>
          )}
          {!plan.isActive && (
            <span className="rounded bg-gray-200 px-2 py-0.5 text-xs text-sh-gray">Inactive</span>
          )}
          <span className="text-xs text-sh-gray">
            {plan.assignedCount} assigned · {plan.tiers.length} tier
            {plan.tiers.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="flex gap-2">
          {editing ? (
            <>
              <button
                type="button"
                onClick={onCancelEdit}
                disabled={busy}
                className="rounded border border-gray-300 px-3 py-1 text-sm text-sh-gray hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onSaveTiers}
                disabled={busy}
                className="rounded bg-sh-navy px-3 py-1 text-sm text-white hover:bg-sh-blue disabled:cursor-not-allowed disabled:opacity-50"
              >
                Save Tiers
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={onBeginEdit}
                className="rounded border border-sh-navy px-3 py-1 text-sm text-sh-navy hover:bg-sh-linen"
              >
                Edit Tiers
              </button>
              {!plan.isDefault && (
                <button
                  type="button"
                  onClick={onMakeDefault}
                  disabled={busy}
                  className="rounded border border-sh-gold px-3 py-1 text-sm text-sh-gold hover:bg-sh-linen disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Make Default
                </button>
              )}
              <button
                type="button"
                onClick={onDelete}
                disabled={busy || blocked !== null}
                title={blocked ?? undefined}
                className="rounded border border-red-300 px-3 py-1 text-sm text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Delete
              </button>
            </>
          )}
        </div>
      </div>
      {plan.description && <p className="mb-2 text-xs text-sh-gray">{plan.description}</p>}

      {editing ? (
        <TierEditor
          tierDraft={tierDraft}
          saveError={saveError}
          updateDraftTier={onUpdateDraftTier}
          addTier={onAddTier}
          removeTier={onRemoveTier}
        />
      ) : (
        <TierCards tiers={plan.tiers} />
      )}
    </div>
  );
}

interface TierEditorProps {
  tierDraft: DraftTier[];
  saveError: string | null;
  updateDraftTier: (i: number, patch: Partial<DraftTier>) => void;
  addTier: () => void;
  removeTier: (i: number) => void;
}

function TierEditor({
  tierDraft,
  saveError,
  updateDraftTier,
  addTier,
  removeTier,
}: Readonly<TierEditorProps>) {
  return (
    <div className="rounded border border-gray-200 bg-white p-3">
      <table className="w-full text-sm">
        <thead className="text-sh-navy">
          <tr>
            <th className="px-2 py-1 text-left">Label</th>
            <th className="px-2 py-1 text-right">Min YTD</th>
            <th className="px-2 py-1 text-right">Max YTD (excl.)</th>
            <th className="px-2 py-1 text-right">Rate %</th>
            <th className="px-2 py-1"></th>
          </tr>
        </thead>
        <tbody>
          {tierDraft.map((t, i) => (
            <tr key={t._draftId} className="border-t border-gray-100">
              <td className="px-2 py-1">
                <input
                  aria-label={`Tier ${i + 1} label`}
                  value={t.label}
                  onChange={(e) => updateDraftTier(i, { label: e.target.value })}
                  className="w-full rounded border border-gray-300 px-2 py-1"
                />
              </td>
              <td className="px-2 py-1 text-right">
                <input
                  aria-label={`Tier ${i + 1} min`}
                  type="number"
                  value={t.minYtdSales}
                  onChange={(e) => updateDraftTier(i, { minYtdSales: Number(e.target.value) })}
                  className="w-32 rounded border border-gray-300 px-2 py-1 text-right"
                />
              </td>
              <td className="px-2 py-1 text-right">
                <input
                  aria-label={`Tier ${i + 1} max`}
                  type="number"
                  value={t.maxYtdSalesExclusive ?? ""}
                  placeholder="∞"
                  onChange={(e) =>
                    updateDraftTier(i, {
                      maxYtdSalesExclusive: e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                  className="w-32 rounded border border-gray-300 px-2 py-1 text-right"
                />
              </td>
              <td className="px-2 py-1 text-right">
                <input
                  aria-label={`Tier ${i + 1} rate`}
                  type="number"
                  step="0.001"
                  value={t.rate}
                  onChange={(e) => updateDraftTier(i, { rate: Number(e.target.value) })}
                  className="w-20 rounded border border-gray-300 px-2 py-1 text-right"
                />
              </td>
              <td className="px-2 py-1 text-right">
                <button
                  type="button"
                  onClick={() => removeTier(i)}
                  aria-label={`Remove tier ${i + 1}`}
                  className="text-xs text-red-600 hover:text-red-800"
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 flex items-center justify-between">
        <p className="text-xs text-sh-gray">
          Rate as decimal (e.g. 0.04 = 4%). Leave Max blank on the last tier for &quot;no upper
          bound&quot;. Brackets must be contiguous.
        </p>
        <button
          type="button"
          onClick={addTier}
          className="rounded border border-sh-gold px-3 py-1 text-xs text-sh-gold hover:bg-sh-linen"
        >
          + Add Tier
        </button>
      </div>
      {saveError && (
        <div className="mt-2 rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-900">
          {saveError}
        </div>
      )}
    </div>
  );
}

function TierCards({ tiers }: Readonly<{ tiers: PlanTierRow[] }>) {
  const money = useMoneyFormatter();
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
      {tiers.map((t) => (
        <div key={t.label} className="rounded border border-gray-200 bg-white p-3 text-center">
          <div className="text-xs uppercase text-sh-gray">{t.label}</div>
          <div className="text-xl font-semibold text-sh-navy">{formatPct(t.rate)}</div>
          <div className="text-xs text-sh-gray">
            {money(t.minYtdSales, { whole: true })} --{" "}
            {t.maxYtdSalesExclusive === null ? "∞" : money(t.maxYtdSalesExclusive, { whole: true })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live calculator — date window, totals, per-salesperson marginal commission.
// ---------------------------------------------------------------------------

interface DateRangeControlsProps {
  startDate: string;
  endDate: string;
  setStartDate: (s: string) => void;
  setEndDate: (s: string) => void;
}

function DateRangeControls({
  startDate,
  endDate,
  setStartDate,
  setEndDate,
}: Readonly<DateRangeControlsProps>) {
  return (
    <section className="mb-6 flex flex-wrap items-end gap-4 print:hidden">
      <div>
        <label htmlFor="start-date" className="block text-xs font-medium text-sh-navy">
          Window Start
        </label>
        <input
          id="start-date"
          type="date"
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
          className="mt-1 rounded border border-gray-300 px-3 py-2 text-sm focus:border-sh-gold focus:outline-none focus:ring-1 focus:ring-sh-gold"
        />
      </div>
      <div>
        <label htmlFor="end-date" className="block text-xs font-medium text-sh-navy">
          Window End
        </label>
        <input
          id="end-date"
          type="date"
          value={endDate}
          onChange={(e) => setEndDate(e.target.value)}
          className="mt-1 rounded border border-gray-300 px-3 py-2 text-sm focus:border-sh-gold focus:outline-none focus:ring-1 focus:ring-sh-gold"
        />
      </div>
      <p className="ml-auto max-w-xs text-xs text-sh-gray">
        Commission earned on sales within the window, marginal across tiers. YTD-at-start is looked
        up from Jan 1 of the start year.
      </p>
    </section>
  );
}

interface TotalsCardsProps {
  totals: { totalWindowSales: number; totalCommission: number };
}

function TotalsCards({ totals }: Readonly<TotalsCardsProps>) {
  const money = useMoneyFormatter();
  return (
    <section className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2">
      <div className="rounded border border-gray-200 bg-white p-4">
        <div className="text-xs uppercase text-sh-gray">Window Sales (all designers)</div>
        <div className="text-2xl font-semibold text-sh-navy">
          {money(totals.totalWindowSales, { whole: true })}
        </div>
      </div>
      <div className="rounded border border-gray-200 bg-white p-4">
        <div className="text-xs uppercase text-sh-gray">Commission Owed (window)</div>
        <div className="text-2xl font-semibold text-sh-navy">
          {money(totals.totalCommission, { whole: true })}
        </div>
      </div>
    </section>
  );
}

interface DesignerTableProps {
  rows: CommissionRow[];
  expandedRow: number | null;
  setExpandedRow: (n: number | null) => void;
}

function DesignerTable({ rows, expandedRow, setExpandedRow }: Readonly<DesignerTableProps>) {
  return (
    <section>
      <h2 className="mb-2 text-lg font-semibold text-sh-navy">By Designer</h2>
      <div className="overflow-x-auto rounded border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-sh-stripe text-sh-navy">
            <tr>
              <th className="px-3 py-2 text-left font-semibold">Designer</th>
              <th className="px-3 py-2 text-left font-semibold">Plan</th>
              <th className="px-3 py-2 text-right font-semibold">YTD at Start</th>
              <th className="px-3 py-2 text-right font-semibold">Window Sales</th>
              <th className="px-3 py-2 text-right font-semibold">YTD at End</th>
              <th className="px-3 py-2 text-left font-semibold">Current Tier</th>
              <th className="px-3 py-2 text-right font-semibold">Commission</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <DesignerRow
                key={r.staffId}
                row={r}
                expanded={expandedRow === r.staffId}
                onToggle={() => setExpandedRow(expandedRow === r.staffId ? null : r.staffId)}
              />
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-sh-gray">
                  No designer had sales in this window.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

interface DesignerRowProps {
  row: CommissionRow;
  expanded: boolean;
  onToggle: () => void;
}

function DesignerRow({ row, expanded, onToggle }: Readonly<DesignerRowProps>) {
  const money = useMoneyFormatter();
  return (
    <>
      <tr className="border-t border-gray-100">
        <td className="px-3 py-2">{row.displayName}</td>
        <td className="px-3 py-2 text-sh-gray">{row.planName}</td>
        <td className="px-3 py-2 text-right text-sh-gray">
          {money(row.ytdAtStart, { whole: true })}
        </td>
        <td className="px-3 py-2 text-right">{money(row.windowSales, { whole: true })}</td>
        <td className="px-3 py-2 text-right">{money(row.ytdAtEnd, { whole: true })}</td>
        <td className="px-3 py-2">{row.currentTierLabel}</td>
        <td className="px-3 py-2 text-right font-semibold">
          {money(row.commission, { whole: true })}
        </td>
        <td className="px-3 py-2 text-right">
          <button type="button" onClick={onToggle} className="text-xs text-sh-navy underline">
            {expanded ? "Hide" : "Breakdown"}
          </button>
        </td>
      </tr>
      {expanded && row.breakdown.length > 0 && (
        <tr className="bg-sh-linen">
          <td colSpan={8} className="px-6 py-2">
            <BreakdownTable breakdown={row.breakdown} />
          </td>
        </tr>
      )}
    </>
  );
}

function BreakdownTable({ breakdown }: Readonly<{ breakdown: Breakdown[] }>) {
  const money = useMoneyFormatter();
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-sh-gray">
          <th className="px-2 py-1 text-left">Tier</th>
          <th className="px-2 py-1 text-right">Rate</th>
          <th className="px-2 py-1 text-right">Sales in Tier</th>
          <th className="px-2 py-1 text-right">Commission</th>
        </tr>
      </thead>
      <tbody>
        {breakdown.map((b) => (
          <tr key={b.tierLabel} className="border-t border-gray-200">
            <td className="px-2 py-1">{b.tierLabel}</td>
            <td className="px-2 py-1 text-right">{formatPct(b.rate)}</td>
            <td className="px-2 py-1 text-right">{money(b.salesInTier, { whole: true })}</td>
            <td className="px-2 py-1 text-right font-semibold">
              {money(b.commission, { whole: true })}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
