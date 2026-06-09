"use client";

// /app/src/components/report/ReportTable.tsx
//
// Generic sortable data table with CSV export. Columns define their own
// formatters so the exported CSV always matches what's shown on screen.
// Client component (interactive sort + CSV export) — usable from both the
// Pages Router and App Router server components.

import { useState, useCallback } from "react";
import Papa from "papaparse";

export interface ReportColumn<T> {
  key: keyof T | string;
  label: string;
  // Formats the value for display. If omitted, raw value is shown.
  format?: (row: T) => string | number | null;
  // Renders JSX in the cell (takes priority over format for display, not CSV).
  // Use for links, badges, or other interactive content.
  render?: (row: T) => React.ReactNode;
  // Overrides format for CSV export only (e.g. unformatted numbers for Excel)
  csvFormat?: (row: T) => string | number | null;
  sortable?: boolean;
  align?: "left" | "right" | "center";
  className?: string;
}

interface ReportTableProps<T> {
  columns: ReportColumn<T>[];
  rows: T[];
  // Row to display at the bottom as a totals/summary row
  totalsRow?: Partial<Record<string, string | number>>;
  exportFilename?: string;
  emptyMessage?: string;
  // Maximum rows to show before paginating (default: no limit)
  pageSize?: number;
  getRowKey: (row: T, index: number) => string | number;
}

type SortDir = "asc" | "desc";

function getDisplayValue<T>(row: T, col: ReportColumn<T>): string | number | null {
  if (col.format) return col.format(row);
  const v = (row as Record<string, unknown>)[col.key as string];
  if (v == null) return null;
  return v as string | number;
}

// For sorting, prefer the raw row value over the formatted display string.
// This ensures numeric columns sort by value, not by "$1,432,080" as a string.
function getSortValue<T>(row: T, col: ReportColumn<T>): string | number | null {
  const raw = (row as Record<string, unknown>)[col.key as string];
  if (raw != null && (typeof raw === "number" || typeof raw === "string")) {
    return raw as string | number;
  }
  return getDisplayValue(row, col);
}

export function ReportTable<T>({
  columns,
  rows,
  totalsRow,
  exportFilename = "report",
  emptyMessage = "No data for this period.",
  pageSize,
  getRowKey,
}: ReportTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(0);

  const handleSort = useCallback(
    (key: string) => {
      if (sortKey === key) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setSortKey(key);
        setSortDir("desc");
      }
      setPage(0);
    },
    [sortKey],
  );

  const sorted = [...rows].sort((a, b) => {
    if (!sortKey) return 0;
    const col = columns.find((c) => c.key === sortKey);
    if (!col) return 0;
    const av = getSortValue(a, col);
    const bv = getSortValue(b, col);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    const cmp =
      typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av).localeCompare(String(bv));
    return sortDir === "asc" ? cmp : -cmp;
  });

  const totalPages = pageSize ? Math.ceil(sorted.length / pageSize) : 1;
  const visible = pageSize ? sorted.slice(page * pageSize, (page + 1) * pageSize) : sorted;

  function handleExport() {
    const csvRows = rows.map((row) => {
      const out: Record<string, string | number | null> = {};
      for (const col of columns) {
        const val = col.csvFormat ? col.csvFormat(row) : getDisplayValue(row, col);
        out[col.label] = val ?? "";
      }
      return out;
    });
    const csv = Papa.unparse(csvRows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${exportFilename}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-3">
      {/* Export button */}
      <div className="flex justify-end">
        <button
          onClick={handleExport}
          disabled={rows.length === 0}
          className="text-xs font-semibold text-sh-blue border border-sh-blue/40 rounded-lg px-3 py-2 hover:bg-sh-blue hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed min-h-[36px] font-sans"
        >
          Export CSV
        </button>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-sh-gray/15 bg-white">
        <table className="w-full text-sm font-sans">
          <thead>
            <tr className="border-b border-sh-gray/15 bg-sh-linen">
              {columns.map((col) => (
                <th
                  key={col.key as string}
                  onClick={col.sortable !== false ? () => handleSort(col.key as string) : undefined}
                  className={[
                    "px-4 py-3 text-xs font-semibold text-sh-gray uppercase tracking-wider whitespace-nowrap",
                    col.align === "right"
                      ? "text-right"
                      : col.align === "center"
                        ? "text-center"
                        : "text-left",
                    col.sortable !== false ? "cursor-pointer select-none hover:text-sh-blue" : "",
                    col.className ?? "",
                  ].join(" ")}
                >
                  {col.label}
                  {sortKey === col.key && (
                    <span className="ml-1 text-sh-blue">{sortDir === "asc" ? "↑" : "↓"}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-4 py-10 text-center text-sh-gray text-sm"
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              visible.map((row, i) => (
                <tr key={getRowKey(row, i)} className={i % 2 === 0 ? "bg-white" : "bg-sh-stripe"}>
                  {columns.map((col) => {
                    const rendered = col.render ? col.render(row) : null;
                    const val = rendered ?? getDisplayValue(row, col);
                    return (
                      <td
                        key={col.key as string}
                        className={[
                          "px-4 py-3 text-sh-black whitespace-nowrap",
                          col.align === "right"
                            ? "text-right"
                            : col.align === "center"
                              ? "text-center"
                              : "text-left",
                          col.className ?? "",
                        ].join(" ")}
                      >
                        {val ?? <span className="text-sh-gray/50">—</span>}
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
            {totalsRow && visible.length > 0 && (
              <tr className="border-t-2 border-sh-gray/20 bg-sh-linen font-semibold">
                {columns.map((col) => {
                  const val = totalsRow[col.key as string];
                  return (
                    <td
                      key={col.key as string}
                      className={[
                        "px-4 py-3 text-sh-black whitespace-nowrap",
                        col.align === "right"
                          ? "text-right"
                          : col.align === "center"
                            ? "text-center"
                            : "text-left",
                      ].join(" ")}
                    >
                      {val ?? ""}
                    </td>
                  );
                })}
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-sh-gray font-sans">
          <span>
            {page * (pageSize ?? rows.length) + 1}–
            {Math.min((page + 1) * (pageSize ?? rows.length), rows.length)} of {rows.length}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => p - 1)}
              disabled={page === 0}
              className="px-3 py-1.5 border border-sh-gray/30 rounded-lg disabled:opacity-40 hover:border-sh-blue min-h-[36px]"
            >
              Prev
            </button>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={page >= totalPages - 1}
              className="px-3 py-1.5 border border-sh-gray/30 rounded-lg disabled:opacity-40 hover:border-sh-blue min-h-[36px]"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
