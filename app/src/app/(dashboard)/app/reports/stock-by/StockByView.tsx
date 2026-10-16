"use client";

// /app/src/app/(dashboard)/app/reports/stock-by/StockByView.tsx
//
// Stock and space report body: pick what to look inside and what to group by;
// each group's units, square feet and share of the measured floor. Answers
// come from /api/reports/stock-by.

import { useState } from "react";
import axios from "axios";
import { treeOrder } from "@/lib/inventory/placeTree";
import { getErrorMessage } from "@/lib/toastError";

interface Place {
  id: number;
  code: string;
  name: string;
  parentId: number | null;
  sortOrder: number;
}

interface Store {
  id: number;
  name: string;
  stockLocations: Place[];
}

interface Result {
  field: string;
  rows: { group: string; units: number; squareFeet: number }[];
  warnings: string[];
}

const EMPTY_SPACE = "Empty space";
const UNMEASURED = "Unmeasured units";

/** "" = every store, "s:<id>" = a store, "p:<id>" = a place. */
function scopeQuery(scope: string): Record<string, number> {
  const [kind, id] = scope.split(":");
  if (kind === "s") return { storeLocationId: Number(id) };
  if (kind === "p") return { stockLocationId: Number(id) };
  return {};
}

export function StockByView({
  stores,
  fields,
  initial,
}: {
  stores: Store[];
  fields: Record<string, string>;
  initial: Result;
}) {
  const [scope, setScope] = useState("");
  const [by, setBy] = useState(initial.field);
  const [result, setResult] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async (nextScope: string, nextBy: string) => {
    setScope(nextScope);
    setBy(nextBy);
    setLoading(true);
    setError(null);
    try {
      const res = await axios.get<Result>("/api/reports/stock-by", {
        params: { by: nextBy, ...scopeQuery(nextScope) },
      });
      setResult(res.data);
    } catch (err) {
      setError(getErrorMessage(err, "Could not load the report."));
    } finally {
      setLoading(false);
    }
  };

  const measuredTotal = result.rows
    .filter((r) => r.group !== UNMEASURED)
    .reduce((s, r) => s + r.squareFeet, 0);
  const unitTotal = result.rows.reduce((s, r) => s + r.units, 0);

  return (
    <div className="py-2 space-y-4 font-serif">
      <h1 className="text-2xl text-brand-blue font-semibold">Stock and space</h1>
      <p className="text-sm text-brand-gray">
        Everything Holt owns inside a store or a place, sold or not, and the share of the floor it
        takes up. A place&apos;s square footage is split over the units in it and in the places
        inside it that have no footage of their own.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="stock-by-scope" className="text-sm text-brand-gray">
          Inside:
        </label>
        <select
          id="stock-by-scope"
          value={scope}
          onChange={(e) => void load(e.target.value, by)}
          className="border border-brand-gray/30 rounded px-2 py-1 text-sm"
        >
          <option value="">Every store</option>
          {stores.map((s) => (
            <optgroup key={s.id} label={s.name}>
              <option value={`s:${s.id}`}>{s.name} (whole store)</option>
              {treeOrder(s.stockLocations).map(({ place, depth }) => (
                <option key={place.id} value={`p:${place.id}`}>
                  {`${"  ".repeat(depth + 1)}${place.code} - ${place.name}`}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <label htmlFor="stock-by-field" className="text-sm text-brand-gray">
          By:
        </label>
        <select
          id="stock-by-field"
          value={by}
          onChange={(e) => void load(scope, e.target.value)}
          className="border border-brand-gray/30 rounded px-2 py-1 text-sm"
        >
          {Object.entries(fields).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        {loading && <span className="text-sm text-brand-gray">Loading…</span>}
      </div>
      {error && <p className="text-sm text-red-700">{error}</p>}
      {result.warnings.length > 0 && (
        <ul className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded p-3 space-y-1">
          {result.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {result.rows.length === 0 && <p className="text-sm text-brand-gray">No stock here.</p>}
      {result.rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-brand-gray border-b border-brand-gray/20">
                <th className="py-2 pr-3">{fields[result.field] ?? "Group"}</th>
                <th className="py-2 pr-3 text-right">Units</th>
                <th className="py-2 pr-3 text-right">Sq ft</th>
                <th className="py-2 text-right">Share of floor</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((r) => {
                const special = r.group === EMPTY_SPACE || r.group === UNMEASURED;
                return (
                  <tr
                    key={r.group}
                    className={`border-b border-brand-gray/10 ${special ? "text-brand-gray italic" : ""}`}
                  >
                    <td className="py-2 pr-3">{r.group}</td>
                    <td className="py-2 pr-3 text-right">{r.units || ""}</td>
                    <td className="py-2 pr-3 text-right">{r.squareFeet || ""}</td>
                    <td className="py-2 text-right">
                      {r.squareFeet && measuredTotal
                        ? `${Math.round((r.squareFeet / measuredTotal) * 1000) / 10}%`
                        : ""}
                    </td>
                  </tr>
                );
              })}
              <tr className="font-semibold">
                <td className="py-2 pr-3">Total</td>
                <td className="py-2 pr-3 text-right">{Math.round(unitTotal * 1000) / 1000}</td>
                {/* Each place's footage is whole; the rows are rounded shares of it. */}
                <td className="py-2 pr-3 text-right">{Math.round(measuredTotal)}</td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
