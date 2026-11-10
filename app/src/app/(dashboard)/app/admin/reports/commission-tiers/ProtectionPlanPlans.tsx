"use client";

// /app/src/app/(dashboard)/app/admin/reports/commission-tiers/ProtectionPlanPlans.tsx
//
// Protection-plan commission plans on the commission screen (GAP-24, DECISIONS 56). A store
// builds a plan of its own for the category its protection plans are in: a percent of the
// price or an amount per plan, with optional brackets, and whether those sales also count
// toward each salesperson's main-plan brackets. What it sends is checked by the shared
// contract in lib/protectionPlanCommission.ts.

import { useEffect, useState } from "react";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { getErrorMessage } from "@/lib/toastError";
import type { ProtectionPlanPays, ProtectionPlanResets } from "@/lib/protectionPlanCommission";

const ENDPOINT = "/api/admin/reports/commission-tiers/tiers";

export interface ProtectionPlanRow {
  id: number;
  name: string;
  description: string | null;
  isDefault: boolean;
  isActive: boolean;
  assignedCount: number;
  protection: {
    categoryId: number | null;
    categoryName: string | null;
    pays: ProtectionPlanPays;
    resets: ProtectionPlanResets;
    alsoCountsInMainPlan: boolean;
    brackets: Array<{ from: number; amount: number }>;
  };
}

/** A bracket as typed: a percent is entered as 10 for 10%. */
interface DraftBracket {
  key: number;
  from: string;
  amount: string;
}

interface Draft {
  name: string;
  categoryId: string;
  pays: ProtectionPlanPays;
  resets: ProtectionPlanResets;
  alsoCountsInMainPlan: boolean;
  brackets: DraftBracket[];
}

let bracketKey = 0;
const newKey = () => ++bracketKey;

function draftFrom(plan: ProtectionPlanRow | null): Draft {
  if (!plan) {
    return {
      name: "",
      categoryId: "",
      pays: "PERCENT",
      resets: "YEAR",
      alsoCountsInMainPlan: false,
      brackets: [{ key: newKey(), from: "0", amount: "" }],
    };
  }
  const p = plan.protection;
  return {
    name: plan.name,
    categoryId: p.categoryId === null ? "" : String(p.categoryId),
    pays: p.pays,
    resets: p.resets,
    alsoCountsInMainPlan: p.alsoCountsInMainPlan,
    brackets: p.brackets.map((b) => ({
      key: newKey(),
      from: String(b.from),
      amount: String(p.pays === "PERCENT" ? Math.round(b.amount * 100000) / 1000 : b.amount),
    })),
  };
}

/** A typed number, or NaN when blank, so the server says what's missing. */
function typed(value: string): number {
  return value.trim() === "" ? Number.NaN : Number(value);
}

/** What the endpoint takes. A percent typed as 10 is sent as 0.1. */
function setupFrom(draft: Draft) {
  return {
    name: draft.name,
    description: null,
    categoryId: draft.categoryId === "" ? null : Number(draft.categoryId),
    pays: draft.pays,
    resets: draft.resets,
    alsoCountsInMainPlan: draft.alsoCountsInMainPlan,
    brackets: draft.brackets.map((b) => ({
      from: typed(b.from),
      amount: draft.pays === "PERCENT" ? typed(b.amount) / 100 : typed(b.amount),
    })),
  };
}

async function send(method: string, body: unknown): Promise<string | null> {
  try {
    const res = await fetch(ENDPOINT, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return null;
    const data = await res.json().catch(() => ({}));
    return data.error || `The plan wasn't saved (HTTP ${res.status}).`;
  } catch (err: unknown) {
    return getErrorMessage(err, "The plan wasn't saved.");
  }
}

export function ProtectionPlanPlans({
  plans,
  onChanged,
}: Readonly<{ plans: ProtectionPlanRow[]; onChanged: () => void }>) {
  const [categories, setCategories] = useState<Array<{ id: number; name: string }>>([]);
  // null: not editing; 0: a new plan; otherwise the plan being edited.
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(null));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/categories?all=true")
      .then((r) => (r.ok ? r.json() : { categories: [] }))
      .then((d) =>
        setCategories(
          (d.categories ?? []).map((c: { id: number; name: string }) => ({
            id: c.id,
            name: c.name,
          })),
        ),
      )
      .catch(() => setCategories([]));
  }, []);

  function begin(plan: ProtectionPlanRow | null) {
    setDraft(draftFrom(plan));
    setEditingId(plan?.id ?? 0);
    setError(null);
  }

  async function run(method: string, body: unknown, after?: () => void) {
    setBusy(true);
    setError(null);
    const problem = await send(method, body);
    setBusy(false);
    if (problem) {
      setError(problem);
      return;
    }
    after?.();
    onChanged();
  }

  const save = () => {
    const setup = setupFrom(draft);
    return editingId === 0
      ? run("POST", { kind: "PROTECTION_PLAN", ...setup }, () => setEditingId(null))
      : run("PUT", { planId: editingId, protectionPlan: setup }, () => setEditingId(null));
  };

  return (
    <section className="mb-6">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-brand-navy">Protection-plan commission</h2>
        {editingId === null && (
          <button
            type="button"
            onClick={() => begin(null)}
            className="rounded border border-brand-navy px-3 py-1 text-sm text-brand-navy hover:bg-brand-linen"
          >
            + New Protection-Plan Plan
          </button>
        )}
      </div>
      <p className="mb-2 text-xs text-brand-gray">
        A plan of its own for the category your protection plans are in. It pays those sales ahead
        of each salesperson&apos;s main plan. Without one, protection plans pay under the main plan
        like any other sale. Staff without an assigned protection-plan plan use the default one.
      </p>

      {error && (
        <div
          role="alert"
          className="mb-2 rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-900"
        >
          {error}
        </div>
      )}

      {editingId === 0 && (
        <PlanForm
          draft={draft}
          setDraft={setDraft}
          categories={categories}
          busy={busy}
          onSave={save}
          onCancel={() => setEditingId(null)}
        />
      )}

      <div className="space-y-3">
        {plans.map((plan) =>
          editingId === plan.id ? (
            <PlanForm
              key={plan.id}
              draft={draft}
              setDraft={setDraft}
              categories={categories}
              busy={busy}
              onSave={save}
              onCancel={() => setEditingId(null)}
            />
          ) : (
            <PlanSummary
              key={plan.id}
              plan={plan}
              busy={busy || editingId !== null}
              onEdit={() => begin(plan)}
              onMakeDefault={() => run("PATCH", { planId: plan.id, action: "setDefault" })}
              onDelete={() => {
                if (window.confirm(`Delete plan "${plan.name}"? This cannot be undone.`)) {
                  void run("DELETE", { planId: plan.id });
                }
              }}
            />
          ),
        )}
      </div>
    </section>
  );
}

function PlanSummary({
  plan,
  busy,
  onEdit,
  onMakeDefault,
  onDelete,
}: Readonly<{
  plan: ProtectionPlanRow;
  busy: boolean;
  onEdit: () => void;
  onMakeDefault: () => void;
  onDelete: () => void;
}>) {
  const money = useMoneyFormatter();
  const p = plan.protection;
  let blocked: string | null = null;
  if (plan.isDefault) blocked = "Make another protection-plan plan the default first.";
  else if (plan.assignedCount > 0) {
    blocked = `${plan.assignedCount} staff assigned to this plan. Reassign them first.`;
  }
  const rate = (amount: number) =>
    p.pays === "PERCENT"
      ? `${Math.round(amount * 100000) / 1000}% of the price`
      : `${money(amount)} per plan`;
  const from = (n: number) => (p.pays === "PERCENT" ? money(n, { whole: true }) : `${n} plans`);
  return (
    <div className="rounded border border-gray-200 bg-white p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-brand-navy">{plan.name}</span>
          {plan.isDefault && (
            <span className="rounded bg-brand-navy px-2 py-0.5 text-xs text-white">Default</span>
          )}
          {!plan.isActive && (
            <span className="rounded bg-gray-200 px-2 py-0.5 text-xs text-brand-gray">
              Inactive
            </span>
          )}
          <span className="text-xs text-brand-gray">{plan.assignedCount} assigned</span>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onEdit}
            disabled={busy}
            className="rounded border border-brand-navy px-3 py-1 text-sm text-brand-navy hover:bg-brand-linen disabled:opacity-50"
          >
            Edit
          </button>
          {!plan.isDefault && (
            <button
              type="button"
              onClick={onMakeDefault}
              disabled={busy}
              className="rounded border border-brand-gold px-3 py-1 text-sm text-brand-gold hover:bg-brand-linen disabled:opacity-50"
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
        </div>
      </div>
      <ul className="space-y-0.5 text-sm text-brand-gray">
        <li>
          Pays on: <strong className="text-brand-navy">{p.categoryName ?? "no category"}</strong>
        </li>
        {p.brackets.map((b, i) => (
          <li key={b.from}>
            {p.brackets.length > 1 && <>From {from(b.from)}: </>}
            <strong className="text-brand-navy">{rate(b.amount)}</strong>
            {i === 0 && p.brackets.length > 1 && (
              <> (brackets start over {p.resets === "YEAR" ? "each January" : "each pay period"})</>
            )}
          </li>
        ))}
        <li>
          {p.alsoCountsInMainPlan
            ? "These sales also count toward each salesperson's main-plan brackets."
            : "These sales don't count toward the main plan's brackets."}
        </li>
      </ul>
    </div>
  );
}

const inputClass = "rounded border border-gray-300 px-2 py-1 text-sm";

function PlanForm({
  draft,
  setDraft,
  categories,
  busy,
  onSave,
  onCancel,
}: Readonly<{
  draft: Draft;
  setDraft: (d: Draft) => void;
  categories: Array<{ id: number; name: string }>;
  busy: boolean;
  onSave: () => void;
  onCancel: () => void;
}>) {
  const percent = draft.pays === "PERCENT";
  const setBracket = (i: number, patch: Partial<DraftBracket>) =>
    setDraft({
      ...draft,
      brackets: draft.brackets.map((b, j) => (j === i ? { ...b, ...patch } : b)),
    });
  return (
    <div className="mb-3 space-y-3 rounded border border-brand-navy/30 bg-white p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block font-semibold text-brand-blue">Plan name</span>
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            className={`w-full ${inputClass}`}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-semibold text-brand-blue">
            Category your protection plans are in
          </span>
          <select
            value={draft.categoryId}
            onChange={(e) => setDraft({ ...draft, categoryId: e.target.value })}
            className={`w-full bg-white ${inputClass}`}
          >
            <option value="">Choose a category</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <fieldset className="text-sm">
        <legend className="mb-1 font-semibold text-brand-blue">Pays</legend>
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              checked={percent}
              onChange={() => setDraft({ ...draft, pays: "PERCENT" })}
            />
            A percent of the plan&apos;s price
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              checked={!percent}
              onChange={() => setDraft({ ...draft, pays: "PER_PLAN" })}
            />
            An amount for each plan sold
          </label>
        </div>
      </fieldset>

      <div className="text-sm">
        <p className="mb-1 font-semibold text-brand-blue">Rates</p>
        <table className="text-sm">
          <thead className="text-xs text-brand-gray">
            <tr>
              <th className="pr-2 text-left font-normal">
                {percent ? "From $ of protection plans sold" : "After this many plans sold"}
              </th>
              <th className="pr-2 text-left font-normal">{percent ? "Percent" : "$ per plan"}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {draft.brackets.map((b, i) => (
              <tr key={b.key}>
                <td className="py-1 pr-2">
                  <input
                    aria-label={`Bracket ${i + 1} starts at`}
                    type="number"
                    min="0"
                    value={b.from}
                    onChange={(e) => setBracket(i, { from: e.target.value })}
                    className={`w-36 text-right ${inputClass}`}
                  />
                </td>
                <td className="py-1 pr-2">
                  <input
                    aria-label={`Bracket ${i + 1} ${percent ? "percent" : "amount per plan"}`}
                    type="number"
                    min="0"
                    step={percent ? "0.1" : "0.01"}
                    value={b.amount}
                    onChange={(e) => setBracket(i, { amount: e.target.value })}
                    className={`w-28 text-right ${inputClass}`}
                  />
                </td>
                <td className="py-1">
                  {draft.brackets.length > 1 && (
                    <button
                      type="button"
                      onClick={() =>
                        setDraft({ ...draft, brackets: draft.brackets.filter((_, j) => j !== i) })
                      }
                      aria-label={`Remove bracket ${i + 1}`}
                      className="text-xs text-red-600 hover:text-red-800"
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button
          type="button"
          onClick={() =>
            setDraft({
              ...draft,
              brackets: [...draft.brackets, { key: newKey(), from: "", amount: "" }],
            })
          }
          className="mt-1 rounded border border-brand-gold px-3 py-1 text-xs text-brand-gold hover:bg-brand-linen"
        >
          + Add Bracket
        </button>
        <p className="mt-1 text-xs text-brand-gray">
          One row is a single rate. Each further row starts a higher bracket, paid on what&apos;s
          sold past it.
        </p>
      </div>

      {draft.brackets.length > 1 && (
        <label className="block text-sm">
          <span className="mb-1 block font-semibold text-brand-blue">Brackets start over</span>
          <select
            value={draft.resets}
            onChange={(e) => setDraft({ ...draft, resets: e.target.value as ProtectionPlanResets })}
            className={`bg-white ${inputClass}`}
          >
            <option value="YEAR">Each January</option>
            <option value="PAY_PERIOD">Each pay period</option>
          </select>
        </label>
      )}

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={draft.alsoCountsInMainPlan}
          onChange={(e) => setDraft({ ...draft, alsoCountsInMainPlan: e.target.checked })}
        />
        <span>
          Also count these sales toward each salesperson&apos;s main-plan brackets
          <span className="block text-xs text-brand-gray">
            They move the salesperson up their main plan&apos;s brackets but are paid only here.
            Off: they count only toward this plan.
          </span>
        </span>
      </label>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded border border-gray-300 px-3 py-1 text-sm text-brand-gray hover:bg-gray-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={busy}
          className="rounded bg-brand-navy px-3 py-1 text-sm text-white hover:bg-brand-blue disabled:cursor-not-allowed disabled:opacity-50"
        >
          Save Plan
        </button>
      </div>
    </div>
  );
}
