"use client";

// /app/src/app/(dashboard)/app/admin/sales/goals/SalesGoalsView.tsx
//
// Salesperson goals body. App Router port of the legacy admin/sales/goals page
// (minus MainLayout chrome, supplied by the (dashboard) layout). Per-designer
// yearly goal + bonus rate, used by the Monthly Performance report. Talks to the
// shared /api/admin/sales/goals + /api/staff REST endpoints.

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { getErrorMessage } from "@/lib/toastError";
import { MONTH_LABELS, evenMonthlyWeights } from "@/lib/goalsConfig";

interface StaffOption {
  id: number;
  displayName: string;
  role: string;
}

interface SalesGoal {
  id: number;
  staffMemberId: number;
  fiscalYear: number;
  yearlyGoal: number;
  bonusRate: number;
  monthlyWeights: number[] | null;
  staffMember: { id: number; displayName: string; role: string };
}

interface EditingGoal {
  staffMemberId: number;
  name: string;
  yearlyGoal: string;
  bonusRate: string;
}

export function SalesGoalsView() {
  const money = useMoneyFormatter();
  const [year, setYear] = useState(new Date().getFullYear());
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [goals, setGoals] = useState<SalesGoal[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<EditingGoal | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    axios
      .get<{ staff: StaffOption[] }>("/api/staff?all=true")
      .then((res) => {
        const list = (res.data.staff || res.data || []) as StaffOption[];
        setStaff(list.filter((s) => ["DESIGNER", "MANAGER"].includes(s.role)));
      })
      .catch(() => {});
  }, []);

  const loadGoals = useCallback(async (fiscalYear: number) => {
    setLoading(true);
    try {
      const res = await axios.get<{ goals: SalesGoal[] }>(
        `/api/admin/sales/goals?year=${fiscalYear}`,
      );
      setGoals(res.data.goals || []);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to load goals."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (staff.length === 0) return;
    loadGoals(year);
  }, [year, staff, loadGoals]);

  const goalFor = (staffMemberId: number) => goals.find((g) => g.staffMemberId === staffMemberId);

  const openEdit = (s: StaffOption) => {
    const existing = goalFor(s.id);
    setEditing({
      staffMemberId: s.id,
      name: s.displayName,
      yearlyGoal: existing ? String(existing.yearlyGoal) : "",
      bonusRate: existing ? String(Math.round(existing.bonusRate * 100)) : "6",
    });
  };

  const handleSave = async () => {
    if (!editing) return;
    const yearlyGoal = Number.parseFloat(editing.yearlyGoal);
    const bonusRate = Number.parseFloat(editing.bonusRate) / 100;
    if (Number.isNaN(yearlyGoal) || yearlyGoal <= 0) {
      toast.warn("Enter a valid yearly goal.");
      return;
    }
    if (Number.isNaN(bonusRate) || bonusRate < 0 || bonusRate > 1) {
      toast.warn("Bonus rate must be 0-100%.");
      return;
    }

    setSaving(true);
    try {
      await axios.put("/api/admin/sales/goals", {
        staffMemberId: editing.staffMemberId,
        fiscalYear: year,
        yearlyGoal,
        bonusRate,
      });
      toast.success("Goal saved.");
      await loadGoals(year);
      setEditing(null);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to save goal."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-serif text-sh-navy">Salesperson Goals</h1>
        <div className="flex items-center gap-2">
          <label htmlFor="goal-year" className="text-sm text-sh-gray">
            Year
          </label>
          <select
            id="goal-year"
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="border border-gray-300 rounded px-3 min-h-[44px] text-sm"
          >
            {Array.from({ length: 5 }, (_, i) => new Date().getFullYear() - i).map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
      </div>

      <p className="text-sm text-sh-gray">
        Goals are used by the Monthly Performance report to calculate variance and bonus. Bonus =
        (sales over monthly goal) × bonus rate. The yearly goal is allocated evenly across the
        twelve months.
      </p>

      {loading ? (
        <p className="text-center text-sm text-sh-gray py-8">Loading…</p>
      ) : (
        <GoalsTable staff={staff} goalFor={goalFor} money={money} onEdit={openEdit} />
      )}

      {editing && (
        <GoalEditModal
          year={year}
          editing={editing}
          saving={saving}
          money={money}
          onChange={setEditing}
          onCancel={() => setEditing(null)}
          onSave={handleSave}
        />
      )}
    </div>
  );
}

type MoneyFormatter = ReturnType<typeof useMoneyFormatter>;

interface GoalsTableProps {
  staff: StaffOption[];
  goalFor: (staffMemberId: number) => SalesGoal | undefined;
  money: MoneyFormatter;
  onEdit: (s: StaffOption) => void;
}

function GoalsTable({ staff, goalFor, money, onEdit }: Readonly<GoalsTableProps>) {
  return (
    <div className="rounded-lg border border-gray-200 overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-sh-linen">
          <tr>
            <th className="px-4 py-3 text-left text-xs font-medium text-sh-gray">Name</th>
            <th className="px-4 py-3 text-right text-xs font-medium text-sh-gray">Yearly Goal</th>
            <th className="px-4 py-3 text-right text-xs font-medium text-sh-gray">Bonus Rate</th>
            <th className="px-4 py-3 text-right text-xs font-medium text-sh-gray">Monthly Avg</th>
            <th className="px-4 py-3"></th>
          </tr>
        </thead>
        <tbody>
          {staff.map((s, i) => {
            const g = goalFor(s.id);
            const yearly = g?.yearlyGoal ?? null;
            const avgMonthly = yearly != null ? Math.round(yearly / 12) : null;
            return (
              <tr
                key={s.id}
                className={`border-b border-gray-100 ${i % 2 === 1 ? "bg-sh-stripe" : "bg-white"}`}
              >
                <td className="px-4 py-3 font-medium text-sh-navy">{s.displayName}</td>
                <td className="px-4 py-3 text-right text-sh-navy">
                  {yearly != null ? (
                    money(yearly, { whole: true })
                  ) : (
                    <span className="text-sh-gray">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right text-sh-gray">
                  {g ? `${Math.round(g.bonusRate * 100)}%` : "—"}
                </td>
                <td className="px-4 py-3 text-right text-sh-gray">
                  {avgMonthly != null ? money(avgMonthly, { whole: true }) : "—"}
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    type="button"
                    onClick={() => onEdit(s)}
                    className="text-xs text-sh-blue hover:underline min-h-[44px] px-2"
                  >
                    {g ? "Edit" : "Set Goal"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface GoalEditModalProps {
  year: number;
  editing: EditingGoal;
  saving: boolean;
  money: MoneyFormatter;
  onChange: (next: EditingGoal) => void;
  onCancel: () => void;
  onSave: () => void;
}

function GoalEditModal({
  year,
  editing,
  saving,
  money,
  onChange,
  onCancel,
  onSave,
}: Readonly<GoalEditModalProps>) {
  // Compute monthly breakdown for a yearly goal using even allocation.
  const monthlyBreakdown = (yearlyGoal: number) =>
    evenMonthlyWeights().map((w) => Math.round(yearlyGoal * w));

  const parsedYearly = Number.parseFloat(editing.yearlyGoal);
  const showBreakdown = Boolean(editing.yearlyGoal) && !Number.isNaN(parsedYearly);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg">
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-serif text-sh-navy">
            {year} Goal — {editing.name}
          </h2>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div>
            <label htmlFor="goal-yearly" className="block text-xs text-sh-gray mb-1">
              Yearly Goal ($)
            </label>
            <input
              id="goal-yearly"
              type="number"
              value={editing.yearlyGoal}
              onChange={(e) => onChange({ ...editing, yearlyGoal: e.target.value })}
              placeholder="e.g. 1000000"
              className="border border-gray-300 rounded px-3 min-h-[44px] w-full text-sm"
            />
          </div>
          <div>
            <label htmlFor="goal-bonus" className="block text-xs text-sh-gray mb-1">
              Bonus Rate (%)
            </label>
            <input
              id="goal-bonus"
              type="number"
              value={editing.bonusRate}
              onChange={(e) => onChange({ ...editing, bonusRate: e.target.value })}
              placeholder="6"
              step="0.1"
              min="0"
              max="100"
              className="border border-gray-300 rounded px-3 min-h-[44px] w-40 text-sm"
            />
            <p className="text-xs text-sh-gray mt-1">
              Percentage of sales above monthly goal paid as bonus.
            </p>
          </div>

          {showBreakdown && (
            <div>
              <p className="text-xs font-medium text-sh-navy mb-2">Monthly breakdown</p>
              <div className="grid grid-cols-4 gap-1 text-xs text-sh-gray">
                {monthlyBreakdown(parsedYearly).map((amt, idx) => (
                  <div
                    key={MONTH_LABELS[idx]}
                    className="flex justify-between bg-sh-linen rounded px-2 py-1"
                  >
                    <span>{MONTH_LABELS[idx]}</span>
                    <span className="font-medium">{money(amt, { whole: true })}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}
