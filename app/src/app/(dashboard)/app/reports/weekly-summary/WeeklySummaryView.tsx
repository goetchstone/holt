"use client";

// /app/src/app/(dashboard)/app/reports/weekly-summary/WeeklySummaryView.tsx
//
// Weekly sales summary with YoY + foot-traffic conversion. Reads the shared
// /api/dashboard/weekly endpoint (used outside the reports domain, so it stays
// REST; a tRPC move is a tracked follow-up). Any signed-in user; the page gated
// server-side.

import { useEffect, useRef, useState, useMemo } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { Bar } from "react-chartjs-2";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
} from "chart.js";
import { format, startOfWeek, subWeeks } from "date-fns";
import MultiSelectDropdown from "@/components/form/MultiSelectDropdown";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend);

type EntityType = "company" | "department" | "supplier";

interface DashboardRow {
  entityName: string;
  actual: number;
  lastYear?: number;
  yoyVariance?: number;
  yoyPercent?: number | null;
  visitors?: number;
  visitorsLastYear?: number;
  conversionPct?: number | null;
  conversionPctLastYear?: number | null;
}

interface ApiResponse {
  weekStart: string;
  weekEnd: string;
  weekLabel?: string;
  lastYear?: { weekStart: string; weekEnd: string; label: string };
  traffic?: {
    totalThisWeek: number;
    totalLastYear: number;
    byStoreThisWeek: Record<string, number>;
    byStoreLastYear: Record<string, number>;
  };
  rows: DashboardRow[];
  availableDepartments: string[];
  message?: string;
}

const defaultStartDate = format(
  startOfWeek(subWeeks(new Date(), 1), { weekStartsOn: 0 }),
  "yyyy-MM-dd",
);

const pct = (value: number | null | undefined) => {
  if (value === null || value === undefined) return "—";
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
};

const signedClass = (value: number) => (value >= 0 ? "text-green-600" : "text-red-600");

const ratePct = (value: number | null | undefined) =>
  value === null || value === undefined ? "—" : `${value.toFixed(1)}%`;

export function WeeklySummaryView() {
  const money = useMoneyFormatter();
  const currency = (value: number) => money(value, { whole: true });

  const [entityType, setEntityType] = useState<EntityType>("company");
  const [data, setData] = useState<ApiResponse | null>(null);
  const [selectedDepartments, setSelectedDepartments] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [startDate, setStartDate] = useState(defaultStartDate);

  const entityTypeRef = useRef(entityType);
  const startDateRef = useRef(startDate);
  const deptsInitialized = useRef(false);

  useEffect(() => {
    entityTypeRef.current = entityType;
  }, [entityType]);
  useEffect(() => {
    startDateRef.current = startDate;
  }, [startDate]);

  useEffect(() => {
    deptsInitialized.current = false;
    setSelectedDepartments([]);
    setLoading(true);
    axios
      .get<ApiResponse>(
        `/api/dashboard/weekly?type=${entityType}&departments=&startDate=${startDate}&wow=1`,
      )
      .then((res) => {
        setData(res.data);
        deptsInitialized.current = true;
        setSelectedDepartments(res.data.availableDepartments || []);
      })
      .catch(() => toast.error("Failed to load dashboard data."))
      .finally(() => setLoading(false));
  }, [entityType, startDate]);

  useEffect(() => {
    if (!deptsInitialized.current) return;
    setLoading(true);
    axios
      .get<ApiResponse>(
        `/api/dashboard/weekly?type=${entityTypeRef.current}&departments=${selectedDepartments.join(",")}&startDate=${startDateRef.current}&wow=1`,
      )
      .then((res) => setData(res.data))
      .catch(() => toast.error("Failed to load dashboard data."))
      .finally(() => setLoading(false));
  }, [selectedDepartments]);

  const isCompany = entityType === "company";

  const chartData = {
    labels: data?.rows.map((r) => r.entityName) || [],
    datasets: [
      {
        label: "This Week",
        data: data?.rows.map((r) => r.actual) || [],
        backgroundColor: "rgba(0, 114, 206, 0.7)",
      },
      {
        label: "Same Week Last Year",
        data: data?.rows.map((r) => r.lastYear ?? 0) || [],
        backgroundColor: "rgba(167, 138, 90, 0.6)",
      },
    ],
  };

  const totals = useMemo(() => {
    const seed = { actual: 0, lastYear: 0, visitors: 0, visitorsLastYear: 0 };
    if (!data?.rows) return seed;
    return data.rows.reduce((acc, row) => {
      acc.actual += row.actual;
      acc.lastYear += row.lastYear ?? 0;
      acc.visitors += row.visitors ?? 0;
      acc.visitorsLastYear += row.visitorsLastYear ?? 0;
      return acc;
    }, seed);
  }, [data?.rows]);

  const totalsYoyPct =
    totals.lastYear === 0 ? null : ((totals.actual - totals.lastYear) / totals.lastYear) * 100;
  const trafficYoyPct =
    data?.traffic && data.traffic.totalLastYear !== 0
      ? ((data.traffic.totalThisWeek - data.traffic.totalLastYear) / data.traffic.totalLastYear) *
        100
      : null;

  return (
    <div className="mx-auto mt-8 max-w-6xl space-y-6 font-serif">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-sh-blue">Weekly Sales Summary</h1>
          {data?.weekLabel && data.lastYear && (
            <p className="text-sh-gray">
              <span>Week of {data.weekLabel}</span>
              <span className="mx-1">vs same week last year</span>
              <span>{data.lastYear.label}</span>
            </p>
          )}
        </div>
        <div className="flex items-end space-x-4">
          <div>
            <label htmlFor="weekStart" className="mb-1 block font-serif text-sm text-sh-black">
              Week (any day in it)
            </label>
            <input
              id="weekStart"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="min-h-[44px] w-full rounded border p-2"
            />
          </div>
          <div>
            <label htmlFor="groupBy" className="mb-1 block font-serif text-sm text-sh-black">
              Group By
            </label>
            <select
              id="groupBy"
              className="min-h-[44px] w-full rounded border p-2"
              value={entityType}
              onChange={(e) => setEntityType(e.target.value as EntityType)}
            >
              <option value="company">Company</option>
              <option value="department">Department</option>
              <option value="supplier">Supplier</option>
            </select>
          </div>
        </div>
      </div>

      {data?.traffic && (
        <div className="flex flex-wrap items-center gap-6 rounded-lg border bg-white p-4 shadow-sm">
          <div>
            <div className="text-xs uppercase tracking-wide text-sh-gray">
              Foot Traffic — This Week
            </div>
            <div className="text-xl font-semibold text-sh-blue">
              {data.traffic.totalThisWeek.toLocaleString()}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-sh-gray">Same Week Last Year</div>
            <div className="text-xl font-semibold text-sh-gray">
              {data.traffic.totalLastYear.toLocaleString()}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-sh-gray">Visitors vs LY</div>
            <div className={`text-xl font-semibold ${signedClass(trafficYoyPct ?? 0)}`}>
              {pct(trafficYoyPct)}
            </div>
          </div>
        </div>
      )}

      {data?.availableDepartments &&
        data.availableDepartments.length > 0 &&
        entityType !== "department" && (
          <div className="flex items-center gap-3">
            <span className="font-serif text-sm text-sh-black">Filter departments</span>
            <MultiSelectDropdown
              label="Departments"
              options={data.availableDepartments.map((d) => ({ value: d, label: d }))}
              selected={selectedDepartments}
              onChange={setSelectedDepartments}
            />
          </div>
        )}

      {loading && <p>Loading report...</p>}
      {!loading && (!data || data.message || data.rows.length === 0) && (
        <p className="p-4 text-center text-sh-gray">
          {data?.message || "No data available for the selected filters."}
        </p>
      )}
      {!loading && data && !data.message && data.rows.length > 0 && (
        <div>
          <div className="mb-8 rounded-lg border bg-white p-4 shadow-sm">
            <Bar
              data={chartData}
              options={{ responsive: true, plugins: { legend: { position: "top" } } }}
            />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="bg-sh-linen">
                  <th className="border-b-2 border-sh-gray p-2">
                    {entityType.charAt(0).toUpperCase() + entityType.slice(1)}
                  </th>
                  <th className="border-b-2 border-sh-gray p-2 text-right">This Week</th>
                  <th className="border-b-2 border-sh-gray p-2 text-right">Last Year</th>
                  <th className="border-b-2 border-sh-gray p-2 text-right">vs LY $</th>
                  <th className="border-b-2 border-sh-gray p-2 text-right">vs LY %</th>
                  {isCompany && (
                    <>
                      <th className="border-b-2 border-sh-gray p-2 text-right">Visitors</th>
                      <th
                        className="border-b-2 border-sh-gray p-2 text-right"
                        title="Sales transactions ÷ door visitors (whole store, ignores the department filter)"
                      >
                        Conv %
                      </th>
                      <th className="border-b-2 border-sh-gray p-2 text-right">Conv % LY</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.entityName} className="odd:bg-white even:bg-gray-50">
                    <td className="border-b border-sh-gray p-2">{r.entityName}</td>
                    <td className="border-b border-sh-gray p-2 text-right">{currency(r.actual)}</td>
                    <td className="border-b border-sh-gray p-2 text-right text-sh-gray">
                      {currency(r.lastYear ?? 0)}
                    </td>
                    <td
                      className={`border-b border-sh-gray p-2 text-right ${signedClass(r.yoyVariance ?? 0)}`}
                    >
                      {currency(r.yoyVariance ?? 0)}
                    </td>
                    <td
                      className={`border-b border-sh-gray p-2 text-right ${signedClass(r.yoyPercent ?? 0)}`}
                    >
                      {pct(r.yoyPercent)}
                    </td>
                    {isCompany && (
                      <>
                        <td className="border-b border-sh-gray p-2 text-right">
                          {(r.visitors ?? 0).toLocaleString()}
                        </td>
                        <td className="border-b border-sh-gray p-2 text-right font-semibold">
                          {ratePct(r.conversionPct)}
                        </td>
                        <td className="border-b border-sh-gray p-2 text-right text-sh-gray">
                          {ratePct(r.conversionPctLastYear)}
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-sh-gray bg-sh-linen font-bold">
                  <td className="p-2">Totals</td>
                  <td className="p-2 text-right">{currency(totals.actual)}</td>
                  <td className="p-2 text-right text-sh-gray">{currency(totals.lastYear)}</td>
                  <td className={`p-2 text-right ${signedClass(totals.actual - totals.lastYear)}`}>
                    {currency(totals.actual - totals.lastYear)}
                  </td>
                  <td className={`p-2 text-right ${signedClass(totalsYoyPct ?? 0)}`}>
                    {pct(totalsYoyPct)}
                  </td>
                  {isCompany && (
                    <>
                      <td className="p-2 text-right">{totals.visitors.toLocaleString()}</td>
                      <td className="p-2 text-right">—</td>
                      <td className="p-2 text-right">—</td>
                    </>
                  )}
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
