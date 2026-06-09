"use client";

// /app/src/app/(dashboard)/app/tools/query-builder/QueryBuilderView.tsx
//
// Ad-hoc data explorer over sales/purchasing/products/consignment. Reads the
// shared /api/tools/query-builder REST endpoint. ADMIN only; the page gated
// server-side. Chrome from the (dashboard) layout.

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { ENTITIES } from "@/lib/queryBuilderConfig";
import type { EntityDef, FilterOption } from "@/lib/queryBuilderConfig";
import axios from "axios";

interface ActiveFilter {
  field: string;
  op: string;
  value: string;
}

interface QueryResult {
  entity: string;
  rowCount: number;
  totalAvailable: string | number;
  columns: string[];
  rows: Record<string, unknown>[];
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    if (Number.isInteger(value)) return String(value);
    return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return String(value);
}

export function QueryBuilderView() {
  const [entityKey, setEntityKey] = useState("");
  const [selectedJoins, setSelectedJoins] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState<ActiveFilter[]>([]);
  const [limit, setLimit] = useState(100);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState("");

  const entity: EntityDef | undefined = ENTITIES.find((e) => e.key === entityKey);

  function toggleJoin(relation: string) {
    setSelectedJoins((prev) => {
      const next = new Set(prev);
      if (next.has(relation)) next.delete(relation);
      else next.add(relation);
      return next;
    });
  }

  function addFilter() {
    if (!entity || entity.filters.length === 0) return;
    setFilters((prev) => [...prev, { field: entity.filters[0].field, op: "equals", value: "" }]);
  }

  function updateFilter(idx: number, key: string, value: string) {
    setFilters((prev) => prev.map((f, i) => (i === idx ? { ...f, [key]: value } : f)));
  }

  function removeFilter(idx: number) {
    setFilters((prev) => prev.filter((_, i) => i !== idx));
  }

  async function runQuery() {
    if (!entityKey) return;
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const res = await axios.post("/api/tools/query-builder", {
        entity: entityKey,
        joins: Array.from(selectedJoins),
        filters: filters.filter((f) => f.value),
        limit,
      });
      setResult(res.data);
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.data?.error) {
        setError(err.response.data.error);
      } else {
        setError("Query failed");
      }
    } finally {
      setLoading(false);
    }
  }

  function exportCsv() {
    if (!result || result.rows.length === 0) return;
    const cols = result.columns;
    const header = cols.join(",");
    const rows = result.rows.map((row) =>
      cols
        .map((c) => {
          const v = formatCell(row[c]);
          return v.includes(",") || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v;
        })
        .join(","),
    );
    const csv = [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${entityKey}-query-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function getFilterDef(field: string): FilterOption | undefined {
    return entity?.filters.find((f) => f.field === field);
  }

  return (
    <div className="space-y-6">
      <h1 className="font-serif text-2xl font-semibold text-sh-blue">Query Builder</h1>

      <div className="space-y-4 rounded-lg border border-sh-gray/20 bg-white p-5 shadow-md">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label htmlFor="entity" className="mb-1 block text-xs font-medium text-sh-gray">
              Entity
            </label>
            <select
              id="entity"
              value={entityKey}
              onChange={(e) => {
                setEntityKey(e.target.value);
                setSelectedJoins(new Set());
                setFilters([]);
                setResult(null);
              }}
              className="min-h-[44px] rounded border border-gray-300 px-3 text-sm"
            >
              <option value="">Select...</option>
              {ENTITIES.map((e) => (
                <option key={e.key} value={e.key}>
                  {e.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="limit" className="mb-1 block text-xs font-medium text-sh-gray">
              Limit
            </label>
            <select
              id="limit"
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="min-h-[44px] rounded border border-gray-300 px-3 text-sm"
            >
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={250}>250</option>
              <option value={500}>500</option>
            </select>
          </div>
        </div>

        {entity && entity.joins.length > 0 && (
          <div>
            <span className="mb-1 block text-xs font-medium text-sh-gray">Include</span>
            <div className="flex flex-wrap gap-2">
              {entity.joins.map((j) => (
                <button
                  key={j.relation}
                  onClick={() => toggleJoin(j.relation)}
                  className={`min-h-[36px] rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                    selectedJoins.has(j.relation)
                      ? "bg-sh-blue text-white"
                      : "bg-sh-linen text-sh-gray hover:bg-sh-gray/10"
                  }`}
                >
                  {j.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {entity && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-sh-gray">Filters</span>
              <button onClick={addFilter} className="text-xs text-sh-blue hover:underline">
                + Add Filter
              </button>
            </div>
            {filters.map((f, i) => (
              <div key={i} className="flex items-center gap-2">
                <select
                  aria-label="Filter field"
                  value={f.field}
                  onChange={(e) => updateFilter(i, "field", e.target.value)}
                  className="min-h-[36px] rounded border border-gray-300 px-2 py-1.5 text-sm"
                >
                  {entity.filters.map((opt) => (
                    <option key={opt.field} value={opt.field}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Filter operator"
                  value={f.op}
                  onChange={(e) => updateFilter(i, "op", e.target.value)}
                  className="min-h-[36px] rounded border border-gray-300 px-2 py-1.5 text-sm"
                >
                  <option value="equals">equals</option>
                  <option value="contains">contains</option>
                  <option value="startsWith">starts with</option>
                  <option value="gt">greater than</option>
                  <option value="gte">greater or equal</option>
                  <option value="lt">less than</option>
                  <option value="lte">less or equal</option>
                  <option value="not">not equal</option>
                </select>
                {getFilterDef(f.field)?.type === "select" ? (
                  <select
                    aria-label="Filter value"
                    value={f.value}
                    onChange={(e) => updateFilter(i, "value", e.target.value)}
                    className="min-h-[36px] flex-1 rounded border border-gray-300 px-2 py-1.5 text-sm"
                  >
                    <option value="">Select...</option>
                    {getFilterDef(f.field)?.options?.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    aria-label="Filter value"
                    value={f.value}
                    onChange={(e) => updateFilter(i, "value", e.target.value)}
                    placeholder="Value..."
                    className="min-h-[36px] flex-1 rounded border border-gray-300 px-2 py-1.5 text-sm"
                  />
                )}
                <button
                  onClick={() => removeFilter(i)}
                  className="min-h-[36px] px-2 text-sm text-red-500 hover:text-red-700"
                >
                  X
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-3">
          <Button onClick={runQuery} disabled={!entityKey || loading} className="min-h-[44px]">
            {loading ? "Running..." : "Run Query"}
          </Button>
          {result && result.rows.length > 0 && (
            <Button variant="outline" onClick={exportCsv} className="min-h-[44px]">
              Export CSV
            </Button>
          )}
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-sh-gold" />
        </div>
      )}

      {error && <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">{error}</div>}

      {result && !loading && (
        <div className="overflow-hidden rounded-lg border border-sh-gray/20 bg-white shadow-md">
          <div className="flex justify-between border-b border-sh-gray/20 bg-sh-linen px-4 py-2 text-sm text-sh-gray">
            <span>
              {result.rowCount} rows{" "}
              {result.totalAvailable !== result.rowCount && `(${result.totalAvailable})`}
            </span>
            <span>{result.columns.length} columns</span>
          </div>
          <div className="max-h-[600px] overflow-x-auto overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 z-10">
                <tr className="border-b border-sh-gray/20 bg-sh-linen">
                  {result.columns.map((col) => (
                    <th
                      key={col}
                      className="whitespace-nowrap px-3 py-2 text-left font-semibold text-sh-gray"
                    >
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, i) => (
                  <tr
                    key={i}
                    className={`border-b border-sh-gray/10 ${i % 2 === 1 ? "bg-sh-stripe" : ""}`}
                  >
                    {result.columns.map((col) => (
                      <td key={col} className="whitespace-nowrap px-3 py-1.5 text-sh-black">
                        {formatCell(row[col])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
