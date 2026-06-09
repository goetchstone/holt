"use client";

// /app/src/app/(dashboard)/app/admin/export/windfall/WindfallExportView.tsx
//
// Windfall data export body. App Router port of the legacy admin/export/windfall
// body (minus MainLayout chrome, which the (dashboard) layout supplies). Streams
// CSV blobs from the shared /api/exports/windfall-* REST endpoints and triggers a
// browser download, reporting the row count from the Content-Disposition filename.

import { useState } from "react";
import { Download, Loader2 } from "lucide-react";

function getPriorWeekRange(): { start: string; end: string } {
  const now = new Date();
  const dayOfWeek = now.getUTCDay();
  // Last Saturday
  const satOffset = dayOfWeek === 0 ? 1 : dayOfWeek + 1;
  const sat = new Date(now);
  sat.setUTCDate(sat.getUTCDate() - satOffset);
  // Sunday before that Saturday
  const sun = new Date(sat);
  sun.setUTCDate(sun.getUTCDate() - 6);
  return {
    start: sun.toISOString().slice(0, 10),
    end: sat.toISOString().slice(0, 10),
  };
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function filenameFromDisposition(res: Response, fallback: string): string {
  const disposition = res.headers.get("Content-Disposition") || "";
  const filenameMatch = disposition.match(/filename="(.+)"/);
  return filenameMatch ? filenameMatch[1] : fallback;
}

/**
 * Fetch a CSV export, download it, and return a status line. Shared by the sales
 * and customer download buttons so the blob/disposition/row-count handling lives
 * in one place. The error path mirrors the endpoints' { error } JSON shape.
 */
async function downloadCsvExport(
  url: string,
  fallbackFilename: string,
  noun: string,
): Promise<string> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as { error?: string } | null;
      return `Error: ${err?.error || "Export failed"}`;
    }
    const blob = await res.blob();
    triggerDownload(blob, filenameFromDisposition(res, fallbackFilename));
    const lines = (await blob.text()).split("\n").length - 1;
    return `Downloaded ${lines.toLocaleString()} ${noun}`;
  } catch {
    return "Error: network request failed";
  }
}

export function WindfallExportView() {
  const priorWeek = getPriorWeekRange();
  const [startDate, setStartDate] = useState(priorWeek.start);
  const [endDate, setEndDate] = useState(priorWeek.end);
  const [salesLoading, setSalesLoading] = useState(false);
  const [customersLoading, setCustomersLoading] = useState(false);
  const [salesResult, setSalesResult] = useState<string | null>(null);
  const [customersResult, setCustomersResult] = useState<string | null>(null);

  const downloadSales = async () => {
    setSalesLoading(true);
    setSalesResult(null);
    const status = await downloadCsvExport(
      `/api/exports/windfall-sales?start=${startDate}&end=${endDate}`,
      "sales_export.csv",
      "line items",
    );
    setSalesResult(status);
    setSalesLoading(false);
  };

  const downloadCustomers = async () => {
    setCustomersLoading(true);
    setCustomersResult(null);
    const status = await downloadCsvExport(
      "/api/exports/windfall-customers",
      "customers_export.csv",
      "customers",
    );
    setCustomersResult(status);
    setCustomersLoading(false);
  };

  return (
    <div className="space-y-8 font-serif">
      <h1 className="text-2xl font-semibold text-sh-navy">Windfall Data Export</h1>

      <div>
        <h2 className="text-lg font-semibold text-sh-navy">Prior Week Sales</h2>
        <p className="mt-1 text-sm text-sh-gray">
          Sales data for the selected date range. Defaults to last Sunday through Saturday.
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-4">
          <div>
            <label htmlFor="windfall-start" className="block text-xs font-medium text-sh-gray mb-1">
              Start Date
            </label>
            <input
              id="windfall-start"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="rounded border border-gray-300 px-3 py-2 min-h-[44px] text-sm focus:border-sh-gold focus:outline-none focus:ring-1 focus:ring-sh-gold"
            />
          </div>
          <div>
            <label htmlFor="windfall-end" className="block text-xs font-medium text-sh-gray mb-1">
              End Date
            </label>
            <input
              id="windfall-end"
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="rounded border border-gray-300 px-3 py-2 min-h-[44px] text-sm focus:border-sh-gold focus:outline-none focus:ring-1 focus:ring-sh-gold"
            />
          </div>
          <button
            onClick={downloadSales}
            disabled={salesLoading || !startDate || !endDate}
            className="inline-flex min-h-[44px] items-center gap-2 rounded bg-sh-navy px-5 py-2 text-sm font-medium text-white hover:bg-sh-navy/90 disabled:opacity-50"
          >
            {salesLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            Download Sales CSV
          </button>
        </div>
        {salesResult && (
          <p
            className={`mt-2 text-sm ${
              salesResult.startsWith("Error") ? "text-red-600" : "text-green-700"
            }`}
          >
            {salesResult}
          </p>
        )}
      </div>

      <hr className="border-gray-200" />

      <div>
        <h2 className="text-lg font-semibold text-sh-navy">Customer Dump</h2>
        <p className="mt-1 text-sm text-sh-gray">
          Full customer export with name, address, and contact info for Windfall matching.
        </p>
        <div className="mt-3">
          <button
            onClick={downloadCustomers}
            disabled={customersLoading}
            className="inline-flex min-h-[44px] items-center gap-2 rounded bg-sh-navy px-5 py-2 text-sm font-medium text-white hover:bg-sh-navy/90 disabled:opacity-50"
          >
            {customersLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            Download Customer CSV
          </button>
        </div>
        {customersResult && (
          <p
            className={`mt-2 text-sm ${
              customersResult.startsWith("Error") ? "text-red-600" : "text-green-700"
            }`}
          >
            {customersResult}
          </p>
        )}
      </div>
    </div>
  );
}
