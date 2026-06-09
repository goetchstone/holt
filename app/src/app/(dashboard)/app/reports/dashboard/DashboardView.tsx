"use client";

// /app/src/app/(dashboard)/app/reports/dashboard/DashboardView.tsx
//
// Weekly sales dashboard (actual vs prorated goal by company/department/supplier).
// Reads the shared /api/dashboard/weekly + /api/departments endpoints (both used
// outside the reports domain, so they stay REST; a tRPC move is a separate
// follow-up). Any signed-in user; the page gated server-side.

import { useEffect, useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import type { Department } from "@prisma/client";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";

type EntityType = "company" | "department" | "supplier";

interface DashboardRow {
  entityName: string;
  actual: number;
  goal: number;
  variance: number;
}

interface ApiResponse {
  weekStart: string;
  weekEnd: string;
  rows: DashboardRow[];
  message?: string;
}

export function DashboardView() {
  const money = useMoneyFormatter();
  const formatCurrency = (v: number) => money(v);

  const [entityType, setEntityType] = useState<EntityType>("department");
  const [data, setData] = useState<ApiResponse | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [selectedDepartments, setSelectedDepartments] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    axios
      .get<{ departments: Department[] }>("/api/departments?all=true")
      .then((res) => setDepartments(res.data.departments || []))
      .catch(() => toast.error("Failed to load departments."));
  }, []);

  useEffect(() => {
    setLoading(true);
    const departmentFilter = selectedDepartments.join(",");
    axios
      .get<ApiResponse>(`/api/dashboard/weekly?type=${entityType}&departments=${departmentFilter}`)
      .then((res) => setData(res.data))
      .catch(() => toast.error("Failed to load dashboard data."))
      .finally(() => setLoading(false));
  }, [entityType, selectedDepartments]);

  return (
    <div className="mx-auto mt-8 max-w-6xl space-y-6 font-serif">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-sh-blue">Sales Report</h1>
          {data?.weekStart && (
            <p className="text-sh-gray">
              For sales period: {data.weekStart} to {data.weekEnd}
            </p>
          )}
        </div>
        <div className="flex items-end space-x-4">
          <div>
            <label htmlFor="group-by" className="mb-1 block font-serif text-sm text-sh-black">
              Group By
            </label>
            <select
              id="group-by"
              className="w-full rounded border p-2"
              value={entityType}
              onChange={(e) => setEntityType(e.target.value as EntityType)}
            >
              <option value="department">Department</option>
              <option value="company">Company</option>
              <option value="supplier">Supplier</option>
            </select>
          </div>
          {entityType === "department" && (
            <div>
              <label htmlFor="dept-filter" className="mb-1 block font-serif text-sm text-sh-black">
                Filter Departments
              </label>
              <select
                id="dept-filter"
                multiple
                className="h-24 w-48 rounded border p-2"
                value={selectedDepartments}
                onChange={(e) =>
                  setSelectedDepartments(Array.from(e.target.selectedOptions, (o) => o.value))
                }
              >
                {departments.map((dept) => (
                  <option key={dept.id} value={dept.name}>
                    {dept.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      </div>

      {loading ? (
        <p>Loading report...</p>
      ) : !data || data.message || data.rows.length === 0 ? (
        <p className="p-4 text-center text-sh-gray">
          {data?.message || "No data available for the selected filters."}
        </p>
      ) : (
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="bg-sh-linen">
              <th className="border-b-2 border-sh-gray p-2">
                {entityType.charAt(0).toUpperCase() + entityType.slice(1)}
              </th>
              <th className="border-b-2 border-sh-gray p-2 text-right">Actual Sales</th>
              <th className="border-b-2 border-sh-gray p-2 text-right">Prorated Goal</th>
              <th className="border-b-2 border-sh-gray p-2 text-right">Variance</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.entityName} className="odd:bg-white even:bg-gray-50">
                <td className="border-b border-sh-gray p-2">{r.entityName}</td>
                <td className="border-b border-sh-gray p-2 text-right">
                  {formatCurrency(r.actual)}
                </td>
                <td className="border-b border-sh-gray p-2 text-right">{formatCurrency(r.goal)}</td>
                <td
                  className={`border-b border-sh-gray p-2 text-right font-bold ${r.variance >= 0 ? "text-green-600" : "text-red-600"}`}
                >
                  {formatCurrency(r.variance)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
