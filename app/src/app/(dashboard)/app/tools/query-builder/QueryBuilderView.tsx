"use client";

// /app/src/app/(dashboard)/app/tools/query-builder/QueryBuilderView.tsx
//
// Ad-hoc reporting (GAP-34): list rows, or group and total them, across what
// lib/queryBuilderConfig.ts offers. Reads the shared /api/tools/query-builder REST
// endpoint, whose answers this prints as they come. Chrome from the (dashboard) layout.

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { csvRow } from "@/lib/csvExport";
import { COUNT_MEASURE, ENTITIES, FILTER_OPS, entityFor } from "@/lib/queryBuilderConfig";
import type { EntityDef, FilterOption } from "@/lib/queryBuilderConfig";
import { measuresOf, type SummaryTable } from "@/lib/queryBuilderSummary";
import axios from "axios";

interface ActiveFilter {
  field: string;
  op: string;
  value: string;
}

interface RowsResult {
  rowCount: number;
  totalAvailable: string | number;
  columns: string[];
  rows: Record<string, unknown>[];
}

type Mode = "rows" | "totals";

const OP_LABELS: Record<string, string> = {
  equals: "equals",
  contains: "contains",
  startsWith: "starts with",
  gt: "greater than",
  gte: "greater or equal",
  lt: "less than",
  lte: "less or equal",
  not: "not equal",
};

const DATE_OP_LABELS: Record<string, string> = {
  equals: "on",
  gt: "after",
  gte: "on or after",
  lt: "before",
  lte: "on or before",
};

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    if (Number.isInteger(value)) return String(value);
    return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return String(value);
}

/** A money total always shows its cents, so a column of them lines up. */
function formatTotal(value: string | number, type: SummaryTable["columns"][number]["type"]) {
  if (typeof value === "string") return value;
  if (type === "decimal") {
    return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return value.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

/** A column's name on the screen: its label, or the key for what the list doesn't name. */
function columnLabels(entity: EntityDef | undefined): Map<string, string> {
  const labels = new Map<string, string>();
  for (const column of entity?.columns ?? []) labels.set(column.field, column.label);
  for (const join of entity?.joins ?? []) {
    labels.set(`${join.relation}._count`, `${join.label} (count)`);
    for (const column of join.columns) labels.set(column.field, column.label);
  }
  return labels;
}

function downloadCsv(name: string, lines: (string | number | null)[][]) {
  const blob = new Blob([lines.map((line) => csvRow(line)).join("")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function errorText(err: unknown): string {
  if (axios.isAxiosError(err) && err.response?.data?.error) return err.response.data.error;
  return "Query failed";
}

export function QueryBuilderView({
  canSeeCost,
  canExport,
}: Readonly<{ canSeeCost: boolean; canExport: boolean }>) {
  const [entityKey, setEntityKey] = useState("");
  const [mode, setMode] = useState<Mode>("rows");
  const [selectedJoins, setSelectedJoins] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState<ActiveFilter[]>([]);
  const [limit, setLimit] = useState(100);
  const [groupBy, setGroupBy] = useState("");
  const [across, setAcross] = useState("");
  const [measures, setMeasures] = useState<string[]>([COUNT_MEASURE]);
  const [loading, setLoading] = useState(false);
  const [rowsResult, setRowsResult] = useState<RowsResult | null>(null);
  const [table, setTable] = useState<SummaryTable | null>(null);
  const [error, setError] = useState("");

  const entities = useMemo(() => ENTITIES.map((e) => entityFor(e, canSeeCost)), [canSeeCost]);
  const entity = entities.find((e) => e.key === entityKey);
  const labels = useMemo(() => columnLabels(entity), [entity]);

  function clearResults() {
    setRowsResult(null);
    setTable(null);
    setError("");
  }

  function pickEntity(key: string) {
    const next = entities.find((e) => e.key === key);
    setEntityKey(key);
    setSelectedJoins(new Set());
    setFilters([]);
    setGroupBy(next?.totals.groups[0]?.key ?? "");
    setAcross("");
    setMeasures([COUNT_MEASURE]);
    clearResults();
  }

  function pickMode(next: Mode) {
    setMode(next);
    clearResults();
  }

  function toggleJoin(relation: string) {
    setSelectedJoins((prev) => {
      const next = new Set(prev);
      if (next.has(relation)) next.delete(relation);
      else next.add(relation);
      return next;
    });
  }

  function pickAcross(key: string) {
    setAcross(key);
    // Going across shows one total at a time.
    if (key) setMeasures((prev) => prev.slice(0, 1));
  }

  function toggleMeasure(key: string) {
    setMeasures((prev) => {
      if (across) return [key];
      if (!prev.includes(key)) return [...prev, key];
      return prev.length > 1 ? prev.filter((m) => m !== key) : prev;
    });
  }

  function getFilterDef(field: string): FilterOption | undefined {
    return entity?.filters.find((f) => f.field === field);
  }

  function addFilter() {
    if (!entity || entity.filters.length === 0) return;
    setFilters((prev) => [...prev, { field: entity.filters[0].field, op: "equals", value: "" }]);
  }

  function updateFilter(idx: number, key: keyof ActiveFilter, value: string) {
    setFilters((prev) =>
      prev.map((f, i) => {
        if (i !== idx) return f;
        // A new field may not take the old operator, or read the old value the same way.
        return key === "field" ? { field: value, op: "equals", value: "" } : { ...f, [key]: value };
      }),
    );
  }

  function removeFilter(idx: number) {
    setFilters((prev) => prev.filter((_, i) => i !== idx));
  }

  function requestBody(exporting: boolean) {
    return {
      entity: entityKey,
      filters: filters.filter((f) => f.value),
      ...(exporting ? { export: true } : {}),
      ...(mode === "totals"
        ? { summary: { groupBy, across: across || null, measures } }
        : { joins: Array.from(selectedJoins), limit }),
    };
  }

  async function runQuery() {
    if (!entityKey) return;
    setLoading(true);
    clearResults();
    try {
      const res = await axios.post("/api/tools/query-builder", requestBody(false));
      if (mode === "totals") setTable(res.data.table);
      else setRowsResult(res.data);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }

  // Run again for the file, so the export is the server's to allow and to record.
  async function exportCsv() {
    setError("");
    try {
      const res = await axios.post("/api/tools/query-builder", requestBody(true));
      if (mode === "totals") {
        const printed: SummaryTable = res.data.table;
        downloadCsv(`${entityKey}-totals`, [
          printed.columns.map((c) => c.label),
          ...printed.rows,
          printed.footer,
        ]);
      } else {
        const printed: RowsResult = res.data;
        downloadCsv(`${entityKey}-query`, [
          printed.columns.map((c) => labels.get(c) ?? c),
          ...printed.rows.map((row) => printed.columns.map((c) => formatCell(row[c]))),
        ]);
      }
    } catch (err) {
      setError(errorText(err));
    }
  }

  const hasResult = (rowsResult?.rows.length ?? 0) > 0 || (table?.rows.length ?? 0) > 0;
  const nothingFound = rowsResult?.rows.length === 0 || table?.rows.length === 0;

  return (
    <div className="space-y-6">
      <h1 className="font-serif text-2xl font-semibold text-brand-blue">Query Builder</h1>

      <div className="space-y-4 rounded-lg border border-brand-gray/20 bg-white p-5 shadow-md">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label htmlFor="entity" className="mb-1 block text-xs font-medium text-brand-gray">
              Report on
            </label>
            <select
              id="entity"
              value={entityKey}
              onChange={(e) => pickEntity(e.target.value)}
              className="min-h-[44px] rounded border border-gray-300 px-3 text-sm"
            >
              <option value="">Select...</option>
              {entities.map((e) => (
                <option key={e.key} value={e.key}>
                  {e.label}
                </option>
              ))}
            </select>
          </div>

          {entity && (
            <fieldset>
              <legend className="mb-1 block text-xs font-medium text-brand-gray">Show</legend>
              <div className="flex gap-2">
                {(["rows", "totals"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={mode === m}
                    onClick={() => pickMode(m)}
                    className={`min-h-[44px] rounded px-4 text-sm font-semibold transition ${
                      mode === m
                        ? "bg-brand-blue text-white"
                        : "bg-brand-linen text-brand-gray hover:bg-brand-gray/10"
                    }`}
                  >
                    {m === "rows" ? "Rows" : "Totals"}
                  </button>
                ))}
              </div>
            </fieldset>
          )}

          {mode === "rows" && (
            <div>
              <label htmlFor="limit" className="mb-1 block text-xs font-medium text-brand-gray">
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
          )}

          {entity && mode === "totals" && (
            <>
              <div>
                <label
                  htmlFor="group-by"
                  className="mb-1 block text-xs font-medium text-brand-gray"
                >
                  Group by
                </label>
                <select
                  id="group-by"
                  value={groupBy}
                  onChange={(e) => {
                    setGroupBy(e.target.value);
                    if (e.target.value === across) setAcross("");
                  }}
                  className="min-h-[44px] rounded border border-gray-300 px-3 text-sm"
                >
                  {entity.totals.groups.map((g) => (
                    <option key={g.key} value={g.key}>
                      {g.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="across" className="mb-1 block text-xs font-medium text-brand-gray">
                  Across (optional)
                </label>
                <select
                  id="across"
                  value={across}
                  onChange={(e) => pickAcross(e.target.value)}
                  className="min-h-[44px] rounded border border-gray-300 px-3 text-sm"
                >
                  <option value="">Nothing</option>
                  {entity.totals.groups
                    .filter((g) => g.key !== groupBy)
                    .map((g) => (
                      <option key={g.key} value={g.key}>
                        {g.label}
                      </option>
                    ))}
                </select>
              </div>
            </>
          )}
        </div>

        {entity && mode === "totals" && (
          <div>
            <span className="mb-1 block text-xs font-medium text-brand-gray">
              {across ? "Total (one at a time going across)" : "Totals"}
            </span>
            <div className="flex flex-wrap gap-2">
              {measuresOf(entity).map((m) => (
                <button
                  key={m.key}
                  type="button"
                  aria-pressed={measures.includes(m.key)}
                  onClick={() => toggleMeasure(m.key)}
                  className={`min-h-[36px] rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                    measures.includes(m.key)
                      ? "bg-brand-blue text-white"
                      : "bg-brand-linen text-brand-gray hover:bg-brand-gray/10"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-brand-gray">{entity.totals.says}</p>
          </div>
        )}

        {entity && mode === "rows" && entity.joins.length > 0 && (
          <div>
            <span className="mb-1 block text-xs font-medium text-brand-gray">Include</span>
            <div className="flex flex-wrap gap-2">
              {entity.joins.map((j) => (
                <button
                  key={j.relation}
                  type="button"
                  onClick={() => toggleJoin(j.relation)}
                  className={`min-h-[36px] rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                    selectedJoins.has(j.relation)
                      ? "bg-brand-blue text-white"
                      : "bg-brand-linen text-brand-gray hover:bg-brand-gray/10"
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
              <span className="text-xs font-medium text-brand-gray">Filters</span>
              <button
                type="button"
                onClick={addFilter}
                className="text-xs text-brand-blue hover:underline"
              >
                + Add Filter
              </button>
            </div>
            {filters.map((f, i) => {
              const def = getFilterDef(f.field);
              const opLabels = def?.type === "date" ? DATE_OP_LABELS : OP_LABELS;
              return (
                <div key={i} className="flex flex-wrap items-center gap-2">
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
                    {FILTER_OPS[def?.type ?? "string"].map((op) => (
                      <option key={op} value={op}>
                        {opLabels[op]}
                      </option>
                    ))}
                  </select>
                  {def?.type === "select" ? (
                    <select
                      aria-label="Filter value"
                      value={f.value}
                      onChange={(e) => updateFilter(i, "value", e.target.value)}
                      className="min-h-[36px] flex-1 rounded border border-gray-300 px-2 py-1.5 text-sm"
                    >
                      <option value="">Select...</option>
                      {def.options?.map((opt) => (
                        <option key={opt} value={opt}>
                          {opt}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      aria-label="Filter value"
                      type={def?.type === "date" ? "date" : "text"}
                      value={f.value}
                      onChange={(e) => updateFilter(i, "value", e.target.value)}
                      placeholder="Value..."
                      className="min-h-[36px] flex-1 rounded border border-gray-300 px-2 py-1.5 text-sm"
                    />
                  )}
                  <button
                    type="button"
                    aria-label="Remove filter"
                    onClick={() => removeFilter(i)}
                    className="min-h-[36px] px-2 text-sm text-red-500 hover:text-red-700"
                  >
                    X
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <div className="flex gap-3">
          <Button onClick={runQuery} disabled={!entityKey || loading} className="min-h-[44px]">
            {loading ? "Running..." : "Run Query"}
          </Button>
          {canExport && hasResult && (
            <Button variant="outline" onClick={exportCsv} className="min-h-[44px]">
              Export CSV
            </Button>
          )}
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-brand-gold" />
        </div>
      )}

      {error && <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">{error}</div>}

      {nothingFound && !loading && (
        <div className="rounded-lg border border-brand-gray/20 bg-white p-4 text-sm text-brand-gray">
          Nothing matches.{table ? ` ${table.population}` : ""}
        </div>
      )}

      {table && table.rows.length > 0 && !loading && (
        <div className="overflow-hidden rounded-lg border border-brand-gray/20 bg-white shadow-md">
          <div className="border-b border-brand-gray/20 bg-brand-linen px-4 py-2 text-xs text-brand-gray">
            From {table.rowsRead.toLocaleString("en-US")} rows. {table.population}
          </div>
          <div className="max-h-[600px] overflow-x-auto overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 z-10">
                <tr className="border-b border-brand-gray/20 bg-brand-linen">
                  {table.columns.map((col, c) => (
                    <th
                      key={col.label}
                      className={`whitespace-nowrap px-3 py-2 font-semibold text-brand-gray ${
                        c === 0 ? "text-left" : "text-right"
                      }`}
                    >
                      {col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, r) => (
                  <tr
                    key={String(row[0])}
                    className={`border-b border-brand-gray/10 ${r % 2 === 1 ? "bg-brand-stripe" : ""}`}
                  >
                    {row.map((cell, c) => (
                      <td
                        key={table.columns[c].label}
                        className={`whitespace-nowrap px-3 py-1.5 text-brand-black ${
                          c === 0 ? "text-left" : "text-right"
                        }`}
                      >
                        {formatTotal(cell, table.columns[c].type)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              <tfoot className="sticky bottom-0">
                <tr className="border-t border-brand-gray/40 bg-brand-linen font-semibold">
                  {table.footer.map((cell, c) => (
                    <td
                      key={table.columns[c].label}
                      className={`whitespace-nowrap px-3 py-2 text-brand-black ${
                        c === 0 ? "text-left" : "text-right"
                      }`}
                    >
                      {formatTotal(cell, table.columns[c].type)}
                    </td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {rowsResult && rowsResult.rows.length > 0 && !loading && (
        <div className="overflow-hidden rounded-lg border border-brand-gray/20 bg-white shadow-md">
          <div className="flex justify-between border-b border-brand-gray/20 bg-brand-linen px-4 py-2 text-sm">
            <span>
              {rowsResult.rowCount} rows{" "}
              {rowsResult.totalAvailable !== rowsResult.rowCount &&
                `(${rowsResult.totalAvailable})`}
            </span>
            <span>{rowsResult.columns.length} columns</span>
          </div>
          <div className="max-h-[600px] overflow-x-auto overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 z-10">
                <tr className="border-b border-brand-gray/20 bg-brand-linen">
                  {rowsResult.columns.map((col) => (
                    <th
                      key={col}
                      className="whitespace-nowrap px-3 py-2 text-left font-semibold text-brand-gray"
                    >
                      {labels.get(col) ?? col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rowsResult.rows.map((row, i) => (
                  <tr
                    key={i}
                    className={`border-b border-brand-gray/10 ${i % 2 === 1 ? "bg-brand-stripe" : ""}`}
                  >
                    {rowsResult.columns.map((col) => (
                      <td key={col} className="whitespace-nowrap px-3 py-1.5 text-brand-black">
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
