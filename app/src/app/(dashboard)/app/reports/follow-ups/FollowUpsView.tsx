"use client";

// /app/src/app/(dashboard)/app/reports/follow-ups/FollowUpsView.tsx
//
// Follow-Ups: who's due across the team, with what each salesperson has outstanding and how
// much outreach they've logged. Filters run here over what's loaded (lib/followUpReport.ts).

import { useMemo, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { parseLocalDate } from "@/lib/dateUtils";
import {
  CONTACT_WINDOW_DAYS,
  DEFAULT_FOLLOW_UP_FILTERS,
  FOLLOW_UP_REPORT_STATUSES,
  filterFollowUpRows,
  type FollowUpReportStatus,
  type FollowUpRow,
} from "@/lib/followUpReport";
import { api } from "@/lib/trpc/client";

const FIELD = "rounded-lg border border-brand-gray/30 bg-white px-3 py-2 text-sm text-brand-black";
const HEAD = "px-3 py-2 text-left text-xs uppercase tracking-wide text-brand-gray";
const CELL = "px-3 py-2 align-top";

function dayLabel(day: string | null): string {
  if (!day) return "Never";
  return parseLocalDate(day).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const STATUS_LABELS: Record<FollowUpRow["status"], string> = {
  due: "Due",
  scheduled: "Scheduled",
  done: "Done",
};

function StatusBadge({ status }: Readonly<{ status: FollowUpRow["status"] }>) {
  const styles = {
    due: "bg-amber-50 text-amber-800 border-amber-200",
    scheduled: "bg-brand-linen text-brand-black border-brand-gray/20",
    done: "bg-green-50 text-green-800 border-green-200",
  };
  return (
    <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${styles[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

function distinct(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

export function FollowUpsView() {
  const money = useMoneyFormatter();
  const fmt = (v: number) => money(v, { whole: true });
  const [filters, setFilters] = useState(DEFAULT_FOLLOW_UP_FILTERS);
  const query = api.reports.followUps.useQuery();
  const rows = useMemo(() => query.data?.rows ?? [], [query.data]);
  const summary = query.data?.summary ?? [];
  const visible = useMemo(() => filterFollowUpRows(rows, filters), [rows, filters]);
  const owners = useMemo(() => distinct(rows.map((row) => row.owner)), [rows]);
  const stores = useMemo(() => distinct(rows.map((row) => row.store)), [rows]);

  return (
    <div className="space-y-6 font-serif">
      <div>
        <h1 className="text-2xl font-semibold text-brand-blue">Follow-Ups</h1>
        <p className="text-sm text-brand-gray">
          Every client with a follow-up date, and who it belongs to: their primary designer, else
          whoever set it, else whoever made their latest sale.
        </p>
      </div>

      {query.isLoading && (
        <p className="flex items-center gap-2 text-sm text-brand-gray">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading follow-ups...
        </p>
      )}
      {query.error && <p className="text-sm text-red-700">{query.error.message}</p>}

      {query.data && (
        <>
          <section className="space-y-2">
            <h2 className="text-lg font-semibold text-brand-black">By salesperson</h2>
            <div className="overflow-x-auto rounded-xl border border-brand-gray/15 bg-white">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-brand-gray/15">
                    <th className={HEAD}>Salesperson</th>
                    <th className={HEAD}>Due</th>
                    <th className={HEAD}>Scheduled</th>
                    <th className={HEAD}>Open quotes</th>
                    <th className={HEAD}>Contacts, last {CONTACT_WINDOW_DAYS} days</th>
                    <th className={HEAD}>Of those, not about a quote</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.map((row) => (
                    <tr key={row.owner} className="border-b border-brand-gray/10 last:border-0">
                      <td className={CELL}>{row.owner}</td>
                      <td className={CELL}>{row.due}</td>
                      <td className={CELL}>{row.scheduled}</td>
                      <td className={CELL}>{fmt(row.openQuoteValue)}</td>
                      <td className={CELL}>{row.contactsLogged}</td>
                      <td className={CELL}>{row.aboutClientNotQuote}</td>
                    </tr>
                  ))}
                  {summary.length === 0 && (
                    <tr>
                      <td className={CELL} colSpan={6}>
                        No follow-ups or contacts yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-brand-black">Clients</h2>
            <div className="flex flex-wrap items-end gap-2">
              <select
                aria-label="Status"
                value={filters.status}
                onChange={(e) =>
                  setFilters({ ...filters, status: e.target.value as FollowUpReportStatus })
                }
                className={FIELD}
              >
                {FOLLOW_UP_REPORT_STATUSES.map((status) => (
                  <option key={status.value} value={status.value}>
                    {status.label}
                  </option>
                ))}
              </select>
              <select
                aria-label="Salesperson"
                value={filters.owner}
                onChange={(e) => setFilters({ ...filters, owner: e.target.value })}
                className={FIELD}
              >
                <option value="">Everyone</option>
                {owners.map((owner) => (
                  <option key={owner} value={owner}>
                    {owner}
                  </option>
                ))}
              </select>
              <select
                aria-label="Store"
                value={filters.store}
                onChange={(e) => setFilters({ ...filters, store: e.target.value })}
                className={FIELD}
              >
                <option value="">All stores</option>
                {stores.map((store) => (
                  <option key={store} value={store}>
                    {store}
                  </option>
                ))}
              </select>
              <label className="text-xs text-brand-gray">
                <span className="mb-1 block">From</span>
                <input
                  type="date"
                  value={filters.from}
                  onChange={(e) => setFilters({ ...filters, from: e.target.value })}
                  className={FIELD}
                />
              </label>
              <label className="text-xs text-brand-gray">
                <span className="mb-1 block">To</span>
                <input
                  type="date"
                  value={filters.to}
                  onChange={(e) => setFilters({ ...filters, to: e.target.value })}
                  className={FIELD}
                />
              </label>
            </div>

            <p className="text-xs text-brand-gray">
              {visible.length} of {rows.length} client{rows.length === 1 ? "" : "s"}
            </p>
            <ul className="space-y-3">
              {visible.map((row) => (
                <li
                  key={row.customerId}
                  className="space-y-1 rounded-xl border border-brand-gray/15 bg-white p-4 text-sm"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link
                      href={`/app/sales/customers/${row.customerId}?tab=notes`}
                      className="font-semibold text-brand-black hover:underline"
                    >
                      {row.clientName}
                    </Link>
                    <span className="flex items-center gap-2">
                      <span className="text-xs text-brand-gray">
                        {dayLabel(row.nextFollowUpDate)}
                      </span>
                      <StatusBadge status={row.status} />
                    </span>
                  </div>
                  <p className="text-xs text-brand-gray">
                    {[row.owner, row.store, row.phone, row.email].filter(Boolean).join(" · ")}
                  </p>
                  <p className="text-xs text-brand-gray">
                    Last contact {dayLabel(row.lastContact)}
                    {row.openQuotes > 0 &&
                      ` · ${row.openQuotes} open quote${row.openQuotes === 1 ? "" : "s"}, ${fmt(row.openQuoteValue)}`}
                    {` · ${fmt(row.lifetimeSpend)} lifetime`}
                    {row.closeLikelihood !== null && ` · Odds ${row.closeLikelihood}/10`}
                    {row.projectTimeline && ` · ${row.projectTimeline}`}
                    {row.budgetRange && ` · ${row.budgetRange}`}
                  </p>
                  {row.lastNote && <p className="text-xs text-brand-black">{row.lastNote}</p>}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
