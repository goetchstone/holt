"use client";

// /app/src/components/table/PaginatedTable.tsx
// Client component (interactive pagination) — usable from both routers.

import React from "react";
import PaginationControls from "./PaginationControls";
import { ArrowUpDown } from "lucide-react";

// ** FIX: Add the optional 'sortable' property **
export interface Column {
  key: string;
  label: string;
  accessor: string;
  sortable?: boolean;
  render?: (row: any) => React.ReactNode;
  width?: string;
  align?: "left" | "center" | "right";
}

interface SortConfig {
  key: string;
  direction: "asc" | "desc";
}

interface PaginatedTableProps<T> {
  data: T[];
  columns: Column[];
  totalCount: number;
  onPageChange: (page: number) => void;
  onRowClick?: (row: T) => void;
  loading?: boolean;
  currentPage: number;
  rowsPerPage?: number;
  onSort?: (key: string) => void;
  sortConfig?: SortConfig;
}

export default function PaginatedTable<T>({
  data,
  columns,
  totalCount,
  onPageChange,
  onRowClick,
  loading,
  currentPage,
  rowsPerPage = 10,
  onSort,
  sortConfig,
}: PaginatedTableProps<T>) {
  // Pad with empty rows so every page renders the same number of rows
  // and pagination controls never shift position.
  const emptyRowCount =
    loading || data.length === 0
      ? Math.max(0, rowsPerPage - 1)
      : Math.max(0, rowsPerPage - data.length);

  return (
    <div className="font-serif text-sm space-y-4">
      <div className="border border-sh-gray rounded-lg overflow-hidden shadow-sm">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={`border-b border-sh-gray px-3 py-2 text-sh-black bg-sh-linen ${
                    col.align === "right"
                      ? "text-right"
                      : col.align === "center"
                        ? "text-center"
                        : "text-left"
                  }`}
                  style={{ width: col.width }}
                >
                  <div
                    className={`flex items-center gap-2 ${col.sortable ? "cursor-pointer" : ""} ${
                      col.align === "right" ? "justify-end" : ""
                    }`}
                    role={col.sortable ? "button" : undefined}
                    tabIndex={col.sortable ? 0 : undefined}
                    onClick={() => col.sortable && onSort && onSort(col.key)}
                    onKeyDown={(e) => {
                      if (!col.sortable || !onSort) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSort(col.key);
                      }
                    }}
                  >
                    {col.label}
                    {col.sortable && <ArrowUpDown className="w-4 h-4 text-gray-400 shrink-0" />}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-2 h-10 text-center">
                  Loading...
                </td>
              </tr>
            ) : data.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-2 h-10 text-center">
                  No results found.
                </td>
              </tr>
            ) : (
              data.map((row, idx) => (
                <tr
                  key={idx}
                  onClick={() => onRowClick?.(row)}
                  className={`${onRowClick ? "cursor-pointer" : ""} hover:bg-sh-gray/10 odd:bg-white even:bg-sh-stripe`}
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={`px-3 py-2 h-10 border-b border-sh-gray ${
                        col.align === "right"
                          ? "text-right"
                          : col.align === "center"
                            ? "text-center"
                            : ""
                      }`}
                      style={{ maxWidth: col.width }}
                    >
                      <div className="truncate">
                        {col.render ? col.render(row) : (row as any)[col.accessor]}
                      </div>
                    </td>
                  ))}
                </tr>
              ))
            )}
            {emptyRowCount > 0 &&
              Array.from({ length: emptyRowCount }).map((_, idx) => (
                <tr key={`empty-${idx}`} aria-hidden="true">
                  {columns.map((col) => (
                    <td key={col.key} className="px-3 py-2 h-10 border-b border-sh-gray">
                      &nbsp;
                    </td>
                  ))}
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <PaginationControls
        totalCount={totalCount}
        currentPage={currentPage}
        onPageChange={onPageChange}
        rowsPerPage={rowsPerPage}
      />
    </div>
  );
}
