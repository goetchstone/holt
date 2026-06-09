"use client";

// /app/src/app/(dashboard)/app/admin/reports/commission-tiers/CommissionTiersView.tsx
//
// Commission tier report body. App Router port of the legacy
// admin/reports/commission-tiers page (minus MainLayout chrome, supplied by the
// (dashboard) layout). Date-range window, marginal-tier math, inline tier
// editor, and the Locked Payouts tab. Talks to the shared
// /api/admin/reports/commission-tiers REST endpoints.

import { useCallback, useEffect, useState } from "react";
import { LockedPayoutsTab } from "@/components/commission/LockedPayoutsTab";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";

type Tab = "preview" | "payouts";

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
}

interface Tier {
  label: string;
  minYtdSales: number;
  maxYtdSalesExclusive: number | null;
  rate: number;
}

/**
 * Draft variant of `Tier` for the inline editor. The `_draftId` is a synthetic
 * stable identifier used as the React `key` on each editor row -- using the
 * array index there would make rows lose focus when a middle row is removed
 * (S6479). The id is stripped from the payload before saving since the API + DB
 * model have no such column.
 */
interface DraftTier extends Tier {
  _draftId: string;
}

let draftIdSeq = 0;
function nextDraftId(): string {
  draftIdSeq += 1;
  return `draft-${draftIdSeq}`;
}

interface ReportData {
  startDate: string;
  endDate: string;
  asOf: string;
  tiers: Tier[];
  rows: CommissionRow[];
  totals: { totalWindowSales: number; totalCommission: number };
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
  const [editingTiers, setEditingTiers] = useState(false);
  const [tierDraft, setTierDraft] = useState<DraftTier[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("preview");

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

  const beginEditTiers = useCallback(() => {
    setTierDraft(data?.tiers.map((t) => ({ ...t, _draftId: nextDraftId() })) ?? []);
    setSaveError(null);
    setEditingTiers(true);
  }, [data]);

  const cancelEditTiers = useCallback(() => {
    setEditingTiers(false);
    setTierDraft([]);
    setSaveError(null);
  }, []);

  const saveTiers = useCallback(async () => {
    setSaveError(null);
    try {
      const res = await fetch("/api/admin/reports/commission-tiers/tiers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // Strip the synthetic _draftId -- API + DB model don't carry it.
        body: JSON.stringify({
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
      setEditingTiers(false);
      load();
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  }, [tierDraft, load]);

  const updateDraftTier = useCallback((i: number, patch: Partial<Tier>) => {
    setTierDraft((prev) => prev.map((t, idx) => (idx === i ? { ...t, ...patch } : t)));
  }, []);

  const addTier = useCallback(() => {
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
    });
  }, []);

  const removeTier = useCallback((i: number) => {
    setTierDraft((prev) => prev.filter((_, idx) => idx !== i));
  }, []);

  return (
    <div>
      <div className="mb-4 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <strong>Owner-confidential.</strong> SUPER_ADMIN only. Tier rates are not for distribution
        to staff. Direct-URL access only -- not linked from any hub page.
      </div>

      <div className="mb-4 flex gap-1 border-b border-sh-stripe">
        <TabButton active={activeTab === "preview"} onClick={() => setActiveTab("preview")}>
          Live Preview
        </TabButton>
        <TabButton active={activeTab === "payouts"} onClick={() => setActiveTab("payouts")}>
          Locked Payouts
        </TabButton>
      </div>

      {activeTab === "payouts" ? (
        <LockedPayoutsTab />
      ) : (
        <LivePreviewSection
          data={data}
          loading={loading}
          startDate={startDate}
          endDate={endDate}
          setStartDate={setStartDate}
          setEndDate={setEndDate}
          editingTiers={editingTiers}
          tierDraft={tierDraft}
          saveError={saveError}
          expandedRow={expandedRow}
          setExpandedRow={setExpandedRow}
          beginEditTiers={beginEditTiers}
          cancelEditTiers={cancelEditTiers}
          saveTiers={saveTiers}
          updateDraftTier={updateDraftTier}
          addTier={addTier}
          removeTier={removeTier}
        />
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

interface LivePreviewSectionProps {
  data: ReportData | null;
  loading: boolean;
  startDate: string;
  endDate: string;
  setStartDate: (s: string) => void;
  setEndDate: (s: string) => void;
  editingTiers: boolean;
  tierDraft: DraftTier[];
  saveError: string | null;
  expandedRow: number | null;
  setExpandedRow: (n: number | null) => void;
  beginEditTiers: () => void;
  cancelEditTiers: () => void;
  saveTiers: () => void;
  updateDraftTier: (i: number, patch: Partial<Tier>) => void;
  addTier: () => void;
  removeTier: (i: number) => void;
}

function LivePreviewSection(props: Readonly<LivePreviewSectionProps>) {
  const {
    data,
    loading,
    startDate,
    endDate,
    setStartDate,
    setEndDate,
    editingTiers,
    tierDraft,
    saveError,
    expandedRow,
    setExpandedRow,
    beginEditTiers,
    cancelEditTiers,
    saveTiers,
    updateDraftTier,
    addTier,
    removeTier,
  } = props;

  return (
    <>
      <DateRangeControls
        startDate={startDate}
        endDate={endDate}
        setStartDate={setStartDate}
        setEndDate={setEndDate}
      />

      <section className="mb-6">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-sh-navy">Tier Structure</h2>
          <TierEditorControls
            editingTiers={editingTiers}
            beginEditTiers={beginEditTiers}
            cancelEditTiers={cancelEditTiers}
            saveTiers={saveTiers}
          />
        </div>

        {editingTiers ? (
          <TierEditor
            tierDraft={tierDraft}
            saveError={saveError}
            updateDraftTier={updateDraftTier}
            addTier={addTier}
            removeTier={removeTier}
          />
        ) : (
          <TierCards tiers={data?.tiers ?? []} />
        )}

        <p className="mt-2 text-xs text-sh-gray">
          Marginal: each tier&apos;s rate applies only to the slice of YTD sales inside that
          tier&apos;s bracket. Tiers are not retroactive -- once a designer crosses a threshold,
          subsequent sales earn the higher rate going forward.
        </p>
      </section>

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
  );
}

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

interface TierEditorControlsProps {
  editingTiers: boolean;
  beginEditTiers: () => void;
  cancelEditTiers: () => void;
  saveTiers: () => void;
}

function TierEditorControls({
  editingTiers,
  beginEditTiers,
  cancelEditTiers,
  saveTiers,
}: Readonly<TierEditorControlsProps>) {
  if (!editingTiers) {
    return (
      <button
        type="button"
        onClick={beginEditTiers}
        className="rounded border border-sh-navy px-3 py-1 text-sm text-sh-navy hover:bg-sh-linen"
      >
        Edit Tiers
      </button>
    );
  }
  return (
    <div className="flex gap-2">
      <button
        type="button"
        onClick={cancelEditTiers}
        className="rounded border border-gray-300 px-3 py-1 text-sm text-sh-gray hover:bg-gray-50"
      >
        Cancel
      </button>
      <button
        type="button"
        onClick={saveTiers}
        className="rounded bg-sh-navy px-3 py-1 text-sm text-white hover:bg-sh-blue"
      >
        Save Tiers
      </button>
    </div>
  );
}

interface TierEditorProps {
  tierDraft: DraftTier[];
  saveError: string | null;
  updateDraftTier: (i: number, patch: Partial<Tier>) => void;
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

function TierCards({ tiers }: Readonly<{ tiers: Tier[] }>) {
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
                <td colSpan={7} className="px-3 py-6 text-center text-sh-gray">
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
          <td colSpan={7} className="px-6 py-2">
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
