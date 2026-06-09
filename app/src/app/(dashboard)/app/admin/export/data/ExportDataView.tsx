"use client";

// /app/src/app/(dashboard)/app/admin/export/data/ExportDataView.tsx
//
// Data export body. App Router port of the legacy admin/export/data body (minus
// MainLayout chrome, which the (dashboard) layout supplies). Date-range General
// Journal export plus one-click per-entity CSV via plain <a download> links to
// the shared /api/accounting/export-journal and /api/admin/export/* endpoints.

import { useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EXPORT_ENTITIES } from "@/lib/genericExport";

function defaultFrom(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return d.toISOString().slice(0, 10);
}

function ExportJournalButton({ href, disabled }: { href: string; disabled: boolean }) {
  const button = (
    <Button type="button" disabled={disabled}>
      <Download className="h-4 w-4" />
      Export Journal
    </Button>
  );
  if (disabled) return button;
  return (
    <a href={href} download>
      {button}
    </a>
  );
}

export function ExportDataView() {
  const [from, setFrom] = useState(defaultFrom());
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));

  const journalHref = `/api/accounting/export-journal?from=${from}&to=${to}`;
  const rangeValid = Boolean(from && to && from <= to);

  return (
    <div className="mx-auto max-w-screen-lg px-4 py-6 font-serif">
      <h1 className="mb-2 text-2xl font-semibold text-sh-navy">Export Data</h1>
      <p className="mb-6 max-w-2xl text-sm text-sh-gray">
        Download your records as CSV. Your data is always yours &mdash; export it any time, with no
        support ticket required. Files open directly in Excel, Numbers, or Google Sheets. Sign-in
        credentials are never included.
      </p>

      {/* Accounting: date-range General Journal for QuickBooks / accountant */}
      <section className="mb-8 rounded-lg border border-sh-gray/20 bg-white p-5">
        <h2 className="font-semibold text-sh-navy">General Journal (QuickBooks)</h2>
        <p className="mb-4 mt-1 text-xs text-sh-gray">
          Export every journal entry in a date range as a General Journal CSV. Imports into
          QuickBooks (Desktop General Journal, or QuickBooks Online via SaasAnt / Transaction Pro),
          Xero, and Sage.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="journal-from" className="mb-1 block text-xs font-medium text-sh-navy">
              From
            </label>
            <input
              id="journal-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="min-h-[44px] rounded border border-sh-gray/30 px-3 py-2 text-sh-black focus:border-sh-navy focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="journal-to" className="mb-1 block text-xs font-medium text-sh-navy">
              To
            </label>
            <input
              id="journal-to"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="min-h-[44px] rounded border border-sh-gray/30 px-3 py-2 text-sh-black focus:border-sh-navy focus:outline-none"
            />
          </div>
          <ExportJournalButton href={journalHref} disabled={!rangeValid} />
        </div>
      </section>

      <h2 className="mb-3 font-semibold text-sh-navy">Records</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {EXPORT_ENTITIES.map((entity) => (
          <div
            key={entity.key}
            className="flex items-center justify-between gap-4 rounded-lg border border-sh-gray/20 bg-white p-4"
          >
            <div className="min-w-0">
              <h3 className="font-semibold text-sh-navy">{entity.label}</h3>
              <p className="text-xs text-sh-gray">{entity.description}</p>
            </div>
            <a href={`/api/admin/export/${entity.key}`} download className="shrink-0">
              <Button variant="secondary" type="button">
                <Download className="h-4 w-4" />
                CSV
              </Button>
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}
