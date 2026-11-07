// /app/src/app/(dashboard)/app/admin/audit/AuditTrailView.tsx
//
// The list and its filter. A plain form and links: there's nothing here that needs a
// script, and read-only means there's nothing to save.

import Link from "next/link";
import { AUDIT_GROUPS } from "@/lib/auditCatalog";
import type { AuditFeed, AuditFilter } from "@/lib/auditFeed";
import { formatDateTime } from "@/lib/formatMoney";

const FIELD = "w-full rounded-lg border border-brand-accent-gray bg-white px-3 py-2 text-sm";

function olderHref(filter: AuditFilter): string {
  const params = new URLSearchParams();
  if (filter.who) params.set("who", filter.who);
  if (filter.group) params.set("group", filter.group);
  if (filter.fromDay) params.set("from", filter.fromDay);
  if (filter.toDay) params.set("to", filter.toDay);
  params.set("page", String(filter.page + 1));
  return `/app/admin/audit?${params.toString()}`;
}

export function AuditTrailView({
  feed,
  filter,
  timezone,
  locale,
}: {
  feed: AuditFeed;
  filter: AuditFilter;
  timezone: string;
  locale: string;
}) {
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div>
        <h1 className="font-serif text-2xl font-semibold text-brand-navy">Audit Trail</h1>
        <p className="text-sm text-brand-gray">
          Who did what, newest first. Nothing here can be edited. Times are your store&apos;s.
        </p>
      </div>

      <form
        method="get"
        action="/app/admin/audit"
        className="grid gap-3 rounded-xl border border-brand-accent-gray bg-white p-4 sm:grid-cols-5"
      >
        <label className="block text-sm sm:col-span-2">
          <span className="text-brand-gray">Who</span>
          <input name="who" defaultValue={filter.who} placeholder="Their email" className={FIELD} />
        </label>
        <label className="block text-sm">
          <span className="text-brand-gray">What</span>
          <select name="group" defaultValue={filter.group ?? ""} className={FIELD}>
            <option value="">Everything</option>
            {Object.entries(AUDIT_GROUPS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="text-brand-gray">From</span>
          <input type="date" name="from" defaultValue={filter.fromDay} className={FIELD} />
        </label>
        <label className="block text-sm">
          <span className="text-brand-gray">To</span>
          <input type="date" name="to" defaultValue={filter.toDay} className={FIELD} />
        </label>
        <div className="sm:col-span-5">
          <button
            type="submit"
            className="rounded-lg bg-brand-navy px-4 py-2 text-sm font-medium text-white"
          >
            Show
          </button>
        </div>
      </form>

      {feed.rows.length === 0 ? (
        <p className="rounded-xl border border-brand-accent-gray bg-white p-5 text-sm text-brand-gray">
          {filter.page > 1 ? "Nothing older than this." : "Nothing matches that yet."}
        </p>
      ) : (
        <ul className="divide-y divide-brand-accent-gray rounded-xl border border-brand-accent-gray bg-white">
          {feed.rows.map((row) => (
            <li key={row.key} className="p-4 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="font-medium text-brand-navy">{row.what}</span>
                <span className="text-brand-gray">
                  {formatDateTime(row.when, { locale, timezone })}
                </span>
              </div>
              <p className="break-words">
                {row.href ? (
                  <Link href={row.href} className="underline">
                    {row.summary}
                  </Link>
                ) : (
                  row.summary
                )}
              </p>
              <p className="break-words text-brand-gray">{row.who ?? "Not recorded"}</p>
            </li>
          ))}
        </ul>
      )}

      {feed.hasMore && (
        <Link href={olderHref(filter)} className="block text-center text-sm underline">
          Show older
        </Link>
      )}
    </div>
  );
}
