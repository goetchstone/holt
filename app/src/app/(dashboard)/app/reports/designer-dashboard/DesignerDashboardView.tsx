"use client";

// /app/src/app/(dashboard)/app/reports/designer-dashboard/DesignerDashboardView.tsx
//
// Client view for the designer performance dashboard. Managers pick a
// salesperson; everyone else is scoped to their own record server-side. Data via
// tRPC; the server procedure resolves the effective salesperson from the session,
// so the client name is only a hint the manager controls. Shows sales, quotes,
// and house call metrics with year-over-year (MTD + YTD) comparisons.

import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";
import { Loader2, Printer } from "lucide-react";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { api } from "@/lib/trpc/client";

interface CategoryRow {
  category: string;
  mtdValue: number;
  prevMtdValue: number;
  mtdVar: number | null;
  ytdValue: number;
  prevYtdValue: number;
  ytdVar: number | null;
}

interface StaffOption {
  id: number;
  displayName: string;
  role?: string;
}

// The tenant-bound currency formatter, threaded to the table subcomponents.
type MoneyFormatter = ReturnType<typeof useMoneyFormatter>;

function formatPct(value: number | null): string {
  if (value === null) return "--";
  return `${(value * 100).toFixed(0)}%`;
}

function VarCell({ value }: Readonly<{ value: number | null }>) {
  if (value === null) return <td className="px-3 py-2 text-center text-sm text-sh-gray">--</td>;
  const isNeg = value < 0;
  return (
    <td
      className={`px-3 py-2 text-center text-sm font-medium ${isNeg ? "text-red-600" : "text-green-700"}`}
    >
      {formatPct(value)}
    </td>
  );
}

function SectionTable({
  title,
  headerColor,
  rows,
  currentYear,
  prevYear,
  valueLabel,
  money,
  extraHeaders,
  extraCells,
}: Readonly<{
  title: string;
  headerColor: string;
  rows: CategoryRow[];
  currentYear: number;
  prevYear: number;
  valueLabel: string;
  money: MoneyFormatter;
  extraHeaders?: React.ReactNode;
  extraCells?: React.ReactNode;
}>) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className={headerColor}>
            <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-sh-navy">
              {title}
            </th>
            <th
              title={`${valueLabel} from the 1st of the current month through today`}
              className="px-3 py-2 text-right text-xs font-semibold text-sh-navy"
            >
              {valueLabel} {currentYear} MTD
            </th>
            <th
              title={`${valueLabel} from the 1st of the same month last year through the same day`}
              className="px-3 py-2 text-right text-xs font-semibold text-sh-navy"
            >
              {valueLabel} {prevYear} MTD
            </th>
            <th
              title="Month-to-date percentage change vs. the same period last year"
              className="px-3 py-2 text-center text-xs font-semibold text-sh-navy"
            >
              VAR
            </th>
            <th
              title={`${valueLabel} from January 1 through today`}
              className="px-3 py-2 text-right text-xs font-semibold text-sh-navy"
            >
              {valueLabel} {currentYear} YTD
            </th>
            <th
              title={`${valueLabel} for the same year-to-date period last year`}
              className="px-3 py-2 text-right text-xs font-semibold text-sh-navy"
            >
              {valueLabel} {prevYear} YTD
            </th>
            <th
              title="Year-to-date percentage change vs. the same period last year"
              className="px-3 py-2 text-center text-xs font-semibold text-sh-navy"
            >
              VAR
            </th>
            {extraHeaders}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const isAll = row.category.startsWith("All");
            return (
              <tr
                key={row.category}
                className={`border-b border-gray-200 ${isAll ? "bg-white font-medium" : i % 2 === 0 ? "bg-sh-stripe" : "bg-white"}`}
              >
                <td
                  className={`px-3 py-2 text-sm ${isAll ? "font-semibold text-sh-navy" : "pl-6 italic text-sh-gray"}`}
                >
                  {row.category}
                </td>
                <td className="px-3 py-2 text-right text-sm">
                  {row.mtdValue > 0 ? money(row.mtdValue, { whole: true }) : ""}
                </td>
                <td className="px-3 py-2 text-right text-sm">
                  {row.prevMtdValue > 0 ? money(row.prevMtdValue, { whole: true }) : ""}
                </td>
                <VarCell value={isAll ? row.mtdVar : null} />
                <td className="px-3 py-2 text-right text-sm">
                  {row.ytdValue > 0 ? money(row.ytdValue, { whole: true }) : ""}
                </td>
                <td className="px-3 py-2 text-right text-sm">
                  {row.prevYtdValue > 0 ? money(row.prevYtdValue, { whole: true }) : ""}
                </td>
                <VarCell value={isAll ? row.ytdVar : null} />
                {isAll ? extraCells : <>{extraHeaders && <td colSpan={4} />}</>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function DesignerDashboardView() {
  const money = useMoneyFormatter();

  const { data: session } = useSession();
  const role = (session as { role?: string } | null)?.role;
  const isManager = role === "MANAGER" || role === "ADMIN" || role === "SUPER_ADMIN";

  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [selectedName, setSelectedName] = useState("");

  useEffect(() => {
    if (isManager) {
      fetch("/api/staff")
        .then((r) => r.json())
        .then((d) => {
          const salesRoles = new Set(["DESIGNER", "MANAGER"]);
          const list = (d.staff || d || [])
            .filter((s: StaffOption) => salesRoles.has(s.role || ""))
            .map((s: StaffOption) => ({
              id: s.id,
              displayName: s.displayName,
            }));
          setStaff(list);
        })
        .catch(() => {});
    } else if (session) {
      fetch("/api/staff/me")
        .then((r) => r.json())
        .then((d) => {
          if (d.displayName) setSelectedName(d.displayName);
        })
        .catch(() => {});
    }
  }, [session, isManager]);

  // Managers must pick a name first; non-managers are resolved server-side.
  const enabled = isManager ? !!selectedName : !!session;
  const query = api.reports.designerDashboard.useQuery({ salesperson: selectedName }, { enabled });
  const loading = query.isFetching;
  const data = query.data;

  return (
    <div className="space-y-6">
      <div className="mb-6 flex items-center gap-4 print:hidden">
        {isManager && (
          <>
            <label htmlFor="designer-dashboard-name" className="text-sm font-medium text-sh-navy">
              Salesperson
            </label>
            <select
              id="designer-dashboard-name"
              value={selectedName}
              onChange={(e) => setSelectedName(e.target.value)}
              className="rounded border border-gray-300 px-3 min-h-[44px] text-sm focus:border-sh-gold focus:outline-none focus:ring-1 focus:ring-sh-gold"
            >
              <option value="">Select a salesperson...</option>
              {staff.map((s) => (
                <option key={s.id} value={s.displayName}>
                  {s.displayName}
                </option>
              ))}
            </select>
          </>
        )}
        {data && (
          <button
            onClick={() => {
              document.body.classList.add("printing-report");
              globalThis.onafterprint = () => {
                document.body.classList.remove("printing-report");
                globalThis.onafterprint = null;
              };
              setTimeout(() => globalThis.print(), 100);
            }}
            className="ml-auto flex items-center gap-2 rounded border border-gray-300 bg-white px-4 py-2 text-sm text-sh-navy hover:bg-sh-linen"
          >
            <Printer className="h-4 w-4" />
            Print
          </button>
        )}
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
        <div className="space-y-8">
          <h2 className="text-lg font-semibold text-sh-navy">
            {data.salesperson} Dashboard &mdash; Through{" "}
            {new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" })} YTD
          </h2>

          {/* SALES */}
          <SectionTable
            title="SALES"
            headerColor="bg-blue-50"
            rows={data.sales.rows}
            currentYear={data.currentYear}
            prevYear={data.prevYear}
            valueLabel="Sales"
            money={money}
            extraHeaders={
              <>
                <th
                  title="Current YTD sales pace projected to a full 12 months"
                  className="px-3 py-2 text-right text-xs font-semibold text-sh-navy"
                >
                  {data.currentYear} Annualized
                </th>
                <th
                  title="Number of completed sales orders placed with this designer year-to-date"
                  className="px-3 py-2 text-center text-xs font-semibold text-sh-navy"
                >
                  # Orders {data.currentYear} YTD
                </th>
                <th
                  title="Average dollar value per completed sales order this year"
                  className="px-3 py-2 text-right text-xs font-semibold text-sh-navy"
                >
                  Avg Order Value
                </th>
                <th
                  title="Average gross margin percentage (selling price minus cost) across all orders this year"
                  className="px-3 py-2 text-right text-xs font-semibold text-sh-navy"
                >
                  Avg Margin YTD
                </th>
              </>
            }
            extraCells={
              <>
                <td className="px-3 py-2 text-right text-sm font-medium">
                  {money(data.sales.annualizedSales, { whole: true })}
                </td>
                <td className="px-3 py-2 text-center text-sm font-medium">
                  {data.sales.orderCount}
                </td>
                <td className="px-3 py-2 text-right text-sm font-medium">
                  {money(data.sales.avgOrderValue, { whole: true })}
                </td>
                <td className="px-3 py-2 text-right text-sm font-medium">
                  {formatPct(data.sales.avgMargin)}
                </td>
              </>
            }
          />

          {/* QUOTES */}
          <SectionTable
            title="QUOTES"
            headerColor="bg-green-50"
            rows={data.quotes.rows}
            currentYear={data.currentYear}
            prevYear={data.prevYear}
            valueLabel="Quotes"
            money={money}
            extraHeaders={
              <>
                <th
                  title="Number of quotes created by this designer year-to-date"
                  className="px-3 py-2 text-center text-xs font-semibold text-sh-navy"
                >
                  # Quotes {data.currentYear} YTD
                </th>
                <th
                  title="Quotes that became orders — count and conversion rate percentage"
                  className="px-3 py-2 text-center text-xs font-semibold text-sh-navy"
                >
                  Converted {data.currentYear} YTD
                </th>
                <th
                  title="Average dollar value of quotes created this year"
                  className="px-3 py-2 text-right text-xs font-semibold text-sh-navy"
                >
                  Avg Quote Value
                </th>
                <th
                  title="Total value of open quotes not yet converted to orders"
                  className="px-3 py-2 text-right text-xs font-semibold text-sh-navy"
                >
                  Open Quotes Value
                </th>
              </>
            }
            extraCells={
              <>
                <td className="px-3 py-2 text-center text-sm font-medium">
                  {data.quotes.quoteCount}
                </td>
                <td className="px-3 py-2 text-center text-sm font-medium">
                  {data.quotes.convertedCount} / {formatPct(data.quotes.conversionRate)}
                </td>
                <td className="px-3 py-2 text-right text-sm font-medium">
                  {money(data.quotes.avgQuoteValue, { whole: true })}
                </td>
                <td className="px-3 py-2 text-right text-sm font-medium">
                  {money(data.quotes.openQuoteValue, { whole: true })}
                </td>
              </>
            }
          />

          {/* HOUSE CALLS */}
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-yellow-50">
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-sh-navy">
                    HOUSE CALLS
                  </th>
                  <th
                    title="Number of house call appointments completed this month"
                    className="px-3 py-2 text-center text-xs font-semibold text-sh-navy"
                  >
                    # Calls {data.currentYear} MTD
                  </th>
                  <th
                    title="Number of house call appointments completed in the same month last year"
                    className="px-3 py-2 text-center text-xs font-semibold text-sh-navy"
                  >
                    # Calls {data.prevYear} MTD
                  </th>
                  <th
                    title="Month-to-date percentage change in house calls vs. last year"
                    className="px-3 py-2 text-center text-xs font-semibold text-sh-navy"
                  >
                    VAR
                  </th>
                  <th
                    title="Number of house call appointments completed year-to-date"
                    className="px-3 py-2 text-center text-xs font-semibold text-sh-navy"
                  >
                    # Calls {data.currentYear} YTD
                  </th>
                  <th
                    title="Number of house call appointments completed in the same period last year"
                    className="px-3 py-2 text-center text-xs font-semibold text-sh-navy"
                  >
                    # Calls {data.prevYear} YTD
                  </th>
                  <th
                    title="Year-to-date percentage change in house calls vs. last year"
                    className="px-3 py-2 text-center text-xs font-semibold text-sh-navy"
                  >
                    VAR
                  </th>
                  <th
                    title="Average value of quotes created during or after a house call appointment"
                    className="px-3 py-2 text-right text-xs font-semibold text-sh-navy"
                  >
                    Avg HCall Quote Value
                  </th>
                  <th
                    title="House call quotes that converted to placed orders — count and rate"
                    className="px-3 py-2 text-center text-xs font-semibold text-sh-navy"
                  >
                    Converted HCall Quotes
                  </th>
                  <th
                    title="Total revenue from orders that originated from a house call appointment"
                    className="px-3 py-2 text-right text-xs font-semibold text-sh-navy"
                  >
                    Total HCall Sales YTD
                  </th>
                  <th
                    title="Average order value for sales that started as house calls"
                    className="px-3 py-2 text-right text-xs font-semibold text-sh-navy"
                  >
                    Avg HCall Sale Value
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-gray-200 bg-white">
                  <td className="px-3 py-2 text-sm font-semibold text-sh-navy" />
                  <td className="px-3 py-2 text-center text-sm font-medium">
                    {data.houseCalls.mtd}
                  </td>
                  <td className="px-3 py-2 text-center text-sm font-medium">
                    {data.houseCalls.prevMtd}
                  </td>
                  <VarCell value={data.houseCalls.mtdVar} />
                  <td className="px-3 py-2 text-center text-sm font-medium">
                    {data.houseCalls.ytd}
                  </td>
                  <td className="px-3 py-2 text-center text-sm font-medium">
                    {data.houseCalls.prevYtd}
                  </td>
                  <VarCell value={data.houseCalls.ytdVar} />
                  <td className="px-3 py-2 text-right text-sm font-medium">
                    {money(data.houseCalls.avgQuoteValue, { whole: true })}
                  </td>
                  <td className="px-3 py-2 text-center text-sm font-medium">
                    {data.houseCalls.convertedCount} / {formatPct(data.houseCalls.conversionRate)}
                  </td>
                  <td className="px-3 py-2 text-right text-sm font-medium">
                    {money(data.houseCalls.totalSalesValue, { whole: true })}
                  </td>
                  <td className="px-3 py-2 text-right text-sm font-medium">
                    {money(data.houseCalls.avgSaleValue, { whole: true })}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
