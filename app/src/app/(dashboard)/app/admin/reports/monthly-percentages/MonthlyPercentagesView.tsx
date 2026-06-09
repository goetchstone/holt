"use client";

// /app/src/app/(dashboard)/app/admin/reports/monthly-percentages/MonthlyPercentagesView.tsx
//
// Monthly sales percentages body. App Router port of the legacy
// admin/reports/monthly-percentages page (minus MainLayout chrome, supplied by
// the (dashboard) layout). Per-month percentage entry that must total 100%.
// Talks to the shared /api/reports/monthly-percentages REST endpoint.

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import type { MonthlySalesPercentage } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";

export function MonthlyPercentagesView() {
  const [percentages, setPercentages] = useState<MonthlySalesPercentage[]>([]);
  const [year, setYear] = useState(new Date().getFullYear());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const fetchPercentages = useCallback(async (currentYear: number) => {
    setLoading(true);
    try {
      const res = await axios.get(`/api/reports/monthly-percentages?year=${currentYear}`);
      if (res.data.length === 0) {
        toast.warn(`No percentages found for ${currentYear}. Please seed them if needed.`);
      }
      setPercentages(res.data);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to fetch percentages for the selected year."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPercentages(year);
  }, [year, fetchPercentages]);

  const handlePercentageChange = (id: number, value: string) => {
    setPercentages((prev) =>
      prev.map((p) => (p.id === id ? { ...p, percentage: Number.parseFloat(value) || 0 } : p)),
    );
  };

  const handleSave = async () => {
    const total = percentages.reduce((acc, p) => acc + p.percentage, 0);
    if (Math.abs(total - 100) > 0.01) {
      toast.error("Total percentage must be exactly 100%.");
      return;
    }

    setSaving(true);
    try {
      await Promise.all(
        percentages.map((p) =>
          axios.put(`/api/reports/monthly-percentages`, {
            id: p.id,
            percentage: p.percentage,
          }),
        ),
      );
      toast.success("Percentages saved successfully!");
      fetchPercentages(year);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to save percentages."));
    } finally {
      setSaving(false);
    }
  };

  const totalPercentage = percentages.reduce((acc, p) => acc + p.percentage, 0);
  const totalIsValid = totalPercentage.toFixed(2) === "100.00";

  return (
    <div className="max-w-2xl mx-auto mt-8 font-serif space-y-4">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-semibold text-sh-blue">Monthly Sales Percentages</h1>
        <div className="flex items-center gap-2">
          <label htmlFor="year-select">Year:</label>
          <input
            type="number"
            id="year-select"
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="border rounded p-2"
          />
        </div>
      </div>

      {loading ? (
        <p>Loading...</p>
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-sh-linen">
              <th className="p-2 border-b-2 border-sh-gray">Month</th>
              <th className="p-2 border-b-2 border-sh-gray text-right">Percentage (%)</th>
            </tr>
          </thead>
          <tbody>
            {percentages.map((p) => (
              <tr key={p.id} className="odd:bg-white even:bg-gray-50">
                <td className="p-2 border-b border-sh-gray">
                  <label htmlFor={`pct-${p.id}`}>{p.month}</label>
                </td>
                <td className="p-2 border-b border-sh-gray">
                  <input
                    id={`pct-${p.id}`}
                    type="number"
                    step="0.01"
                    value={p.percentage}
                    onChange={(e) => handlePercentageChange(p.id, e.target.value)}
                    className="text-right w-full p-1 border rounded"
                  />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-bold bg-sh-linen">
              <td className="p-2">Total</td>
              <td className={`p-2 text-right ${totalIsValid ? "" : "text-red-600"}`}>
                {totalPercentage.toFixed(2)}%
              </td>
            </tr>
          </tfoot>
        </table>
      )}
      <div className="text-right">
        <Button onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save Changes"}
        </Button>
      </div>
    </div>
  );
}
