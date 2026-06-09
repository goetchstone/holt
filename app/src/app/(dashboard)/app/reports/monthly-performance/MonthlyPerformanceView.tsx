"use client";

// /app/src/app/(dashboard)/app/reports/monthly-performance/MonthlyPerformanceView.tsx
//
// Client view for the monthly performance report. Managers pick a salesperson;
// everyone else is scoped to their own record server-side. Data via tRPC; the
// server procedure resolves the effective salesperson from the session, so the
// client name is only a hint the manager controls. Custom table because each cell
// has bespoke conditional formatting + a salesperson-detail drilldown link.

import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { api } from "@/lib/trpc/client";

interface StaffOption {
  id: number;
  displayName: string;
  role: string;
}

function formatPct(value: number | null): string {
  if (value === null) return "";
  return `${(value * 100).toFixed(2)}%`;
}

export function MonthlyPerformanceView() {
  const money = useMoneyFormatter();
  // Blank for zero so the dense grid stays readable (matches the original).
  const c = (v: number) => (v === 0 ? "" : money(v, { whole: true }));

  const { data: session } = useSession();
  const role = (session as { role?: string } | null)?.role;
  const isManager = role === "MANAGER" || role === "ADMIN" || role === "SUPER_ADMIN";

  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [selectedName, setSelectedName] = useState("");
  const [year, setYear] = useState(new Date().getFullYear());

  useEffect(() => {
    if (!isManager) return;
    fetch("/api/staff")
      .then((r) => r.json())
      .then((d) => {
        const salesRoles = new Set(["DESIGNER", "MANAGER"]);
        setStaff(
          (d.staff || d || [])
            .filter((s: StaffOption) => salesRoles.has(s.role))
            .map((s: StaffOption) => ({ id: s.id, displayName: s.displayName, role: s.role })),
        );
      })
      .catch(() => {});
  }, [isManager]);

  // Managers must pick a name first; non-managers are resolved server-side.
  const enabled = isManager ? !!selectedName : !!session;
  const query = api.reports.monthlyPerformance.useQuery(
    { salesperson: selectedName, year },
    { enabled },
  );
  const loading = query.isFetching;
  const data = query.data;

  const currentYear = new Date().getFullYear();
  const yearOptions = Array.from({ length: 5 }, (_, i) => currentYear - i);

  return (
    <div className="space-y-6 font-serif">
      <nav className="text-sm text-sh-gray">
        <Link href="/app/reports" className="hover:underline">
          Reports
        </Link>
        <span className="mx-2">/</span>
        <span className="text-sh-black">Monthly Performance</span>
      </nav>
      <h1 className="text-2xl font-semibold text-sh-navy">Monthly Performance</h1>

      <div className="flex flex-wrap items-center gap-4">
        {isManager && (
          <div>
            <label htmlFor="sp" className="mb-1 block text-xs font-medium text-sh-gray">
              Salesperson
            </label>
            <select
              id="sp"
              value={selectedName}
              onChange={(e) => setSelectedName(e.target.value)}
              className="min-h-[44px] rounded border border-gray-300 px-3 text-sm focus:border-sh-gold focus:outline-none focus:ring-1 focus:ring-sh-gold"
            >
              <option value="">Select...</option>
              {staff.map((s) => (
                <option key={s.id} value={s.displayName}>
                  {s.displayName}
                </option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label htmlFor="yr" className="mb-1 block text-xs font-medium text-sh-gray">
            Year
          </label>
          <select
            id="yr"
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="min-h-[44px] rounded border border-gray-300 px-3 text-sm focus:border-sh-gold focus:outline-none focus:ring-1 focus:ring-sh-gold"
          >
            {yearOptions.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-sh-gold" />
        </div>
      )}

      {!loading && isManager && !selectedName && (
        <p className="py-8 text-center text-sm text-sh-gray">Select a salesperson.</p>
      )}

      {!loading && enabled && !data && (
        <p className="py-8 text-center text-sm text-sh-gray">No data found.</p>
      )}

      {data && !loading && (
        <>
          <div className="rounded-lg border border-gray-200 bg-white px-5 py-4">
            <h2 className="text-lg font-semibold text-sh-navy">{data.salesperson}</h2>
            {data.yearlyGoal > 0 ? (
              <p className="mt-1 text-sm text-sh-gray">
                Yearly goal is{" "}
                <span className="font-semibold text-sh-navy">
                  {money(data.yearlyGoal, { whole: true })}
                </span>{" "}
                sales to date are{" "}
                <span className="font-semibold text-sh-navy">
                  {money(data.totals.sales, { whole: true })}
                </span>{" "}
                the goal to date is{" "}
                <span className="font-semibold text-sh-navy">
                  {money(data.totals.goal, { whole: true })}
                </span>
              </p>
            ) : (
              <p className="mt-1 text-sm text-amber-600">
                No yearly goal set for {data.year}. Goals can be configured in Admin &gt; Staff.
              </p>
            )}
          </div>

          <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-sh-linen">
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-sh-navy">
                    Month
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-sh-navy">Sales</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-sh-navy">Goal</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-sh-navy">Var</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-sh-navy" />
                  <th className="px-4 py-3 text-right text-xs font-semibold text-sh-navy">Bonus</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-sh-navy">
                    Orders
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-sh-navy">
                    Avg Order
                  </th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-sh-navy">
                    Quotes
                  </th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-sh-navy">
                    Converted
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.months.map((row, i) => {
                  const isNeg = row.variance < 0;
                  const hasSales = row.sales > 0;
                  return (
                    <tr
                      key={row.month}
                      className={`border-b border-gray-100 ${i % 2 === 1 ? "bg-sh-stripe" : "bg-white"}`}
                    >
                      <td className="px-4 py-3 text-sm font-semibold text-sh-navy">
                        {hasSales ? (
                          <Link
                            href={`/app/reports/salesperson-detail?salesperson=${encodeURIComponent(data.salesperson)}&year=${data.year}`}
                            className="hover:text-sh-gold hover:underline"
                          >
                            {row.label}
                          </Link>
                        ) : (
                          row.label
                        )}
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-sh-navy">
                        {hasSales ? c(row.sales) : ""}
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-sh-gray">
                        {row.goal > 0 ? c(row.goal) : ""}
                      </td>
                      <td
                        className={`px-4 py-3 text-right text-sm font-medium ${isNeg ? "text-red-600" : hasSales ? "text-sh-navy" : ""}`}
                      >
                        {hasSales && row.goal > 0 ? c(row.variance) : ""}
                      </td>
                      <td
                        className={`px-4 py-3 text-right text-sm font-medium ${isNeg ? "text-red-600" : ""}`}
                      >
                        {hasSales && row.goal > 0 ? formatPct(row.variancePct) : ""}
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-sh-navy">
                        {row.bonus > 0 ? c(row.bonus) : hasSales ? "$0" : ""}
                      </td>
                      <td className="px-4 py-3 text-center text-sm text-sh-navy">
                        {row.orderCount > 0 ? row.orderCount : hasSales ? "0" : ""}
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-sh-navy">
                        {row.avgOrderValue > 0 ? c(row.avgOrderValue) : ""}
                      </td>
                      <td className="px-4 py-3 text-center text-sm text-sh-navy">
                        {row.quoteCount > 0 ? row.quoteCount : hasSales ? "0" : ""}
                      </td>
                      <td className="px-4 py-3 text-center text-sm text-sh-navy">
                        {row.conversionRate != null
                          ? `${Math.round(row.conversionRate * 100)}%`
                          : hasSales
                            ? "0%"
                            : ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-gray-300 bg-white font-semibold">
                  <td className="px-4 py-3 text-sm text-sh-navy" />
                  <td className="px-4 py-3 text-right text-sm text-sh-navy">
                    {money(data.totals.sales, { whole: true })}
                  </td>
                  <td className="px-4 py-3 text-right text-sm text-sh-gray">
                    {data.totals.goal > 0 ? money(data.totals.goal, { whole: true }) : ""}
                  </td>
                  <td
                    className={`px-4 py-3 text-right text-sm ${data.totals.variance < 0 ? "text-red-600" : "text-sh-navy"}`}
                  >
                    {data.totals.goal > 0 ? money(data.totals.variance, { whole: true }) : ""}
                  </td>
                  <td
                    className={`px-4 py-3 text-right text-sm ${data.totals.variance < 0 ? "text-red-600" : ""}`}
                  >
                    {data.totals.goal > 0 ? formatPct(data.totals.variancePct) : ""}
                  </td>
                  <td className="px-4 py-3 text-right text-sm text-sh-navy" />
                  <td className="px-4 py-3 text-center text-sm text-sh-navy">
                    {data.totals.orderCount}
                  </td>
                  <td className="px-4 py-3 text-right text-sm text-sh-navy" />
                  <td className="px-4 py-3 text-center text-sm text-sh-navy">
                    {data.totals.quoteCount}
                  </td>
                  <td className="px-4 py-3 text-center text-sm text-sh-navy">
                    {data.totals.conversionRate != null
                      ? `${Math.round(data.totals.conversionRate * 100)}%`
                      : ""}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
