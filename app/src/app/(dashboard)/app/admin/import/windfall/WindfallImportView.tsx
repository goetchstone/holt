"use client";

// /app/src/app/(dashboard)/app/admin/import/windfall/WindfallImportView.tsx
//
// Windfall enrichment import body. App Router port of the legacy
// admin/import/windfall body (minus MainLayout chrome, which the (dashboard)
// layout supplies). Parses the enriched customer CSV client-side, previews the
// matched/derived wealth data, then POSTs to the shared
// /api/customers/windfall-import REST endpoint.

import { useState, type ChangeEvent } from "react";
import { toast } from "react-toastify";
import Papa from "papaparse";
import axios from "axios";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";
import { parseWindfallCustomerRow, computeWealthTier } from "@/lib/windfallImport";
import type { WindfallParsedRow } from "@/lib/windfallImport";

interface WindfallImportResult {
  imported: number;
  skipped: number;
  total: number;
  message: string;
}

const TIER_LABELS: Record<string, string> = {
  ULTRA_HIGH: "$10M+",
  VERY_HIGH: "$5-10M",
  HIGH: "$1-5M",
  AFFLUENT: "$500K-1M",
};

const PREVIEW_LIMIT = 100;

function formatNetWorth(nw: number | null): string {
  if (nw == null) return "—";
  if (nw >= 1_000_000) return `$${(nw / 1_000_000).toFixed(1)}M`;
  if (nw >= 1_000) return `$${Math.round(nw / 1_000)}K`;
  return `$${nw}`;
}

function formatConfidence(confidence: number | null | undefined): string {
  return confidence != null ? `${Math.round(confidence * 100)}%` : "—";
}

function formatName(row: WindfallParsedRow): string {
  return [row.firstName, row.lastName].filter(Boolean).join(" ") || "—";
}

function signalsFor(row: WindfallParsedRow): string[] {
  return [
    row.boatOwner && "Boat",
    row.multiPropertyOwner && "Multi-property",
    row.philanthropicGiver && "Philanthropic",
    row.recentMover && "Recent Mover",
    row.smallBusinessOwner && "Business",
    row.politicalDonor && "Political",
  ].filter((s): s is string => Boolean(s));
}

export function WindfallImportView() {
  const [rows, setRows] = useState<WindfallParsedRow[]>([]);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<WindfallImportResult | null>(null);

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setResult(null);
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h: string) => h.trim(),
      complete: (results) => {
        const parsed = results.data
          .map((r) => parseWindfallCustomerRow(r))
          .filter((r): r is WindfallParsedRow => r !== null);
        setRows(parsed);
        toast.info(`Parsed ${parsed.length} rows. Review and click Import.`);
      },
      error: (err: unknown) => {
        toast.error(`Error parsing file: ${err instanceof Error ? err.message : "Unknown error"}`);
      },
    });
  };

  const handleImport = async () => {
    if (rows.length === 0) {
      toast.error("No rows to import.");
      return;
    }

    setImporting(true);
    try {
      const res = await axios.post<WindfallImportResult>("/api/customers/windfall-import", {
        rows,
      });
      setResult(res.data);
      toast.success(res.data.message);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Import failed"));
    } finally {
      setImporting(false);
    }
  };

  const matchedCount = rows.filter((r) => r.windfallId).length;
  const unmatchedCount = rows.length - matchedCount;

  return (
    <div className="py-2 space-y-5 font-serif">
      <div className="flex items-center gap-3">
        <Link href="/app/admin/import" className="text-sh-blue hover:underline text-sm">
          Import Tools
        </Link>
        <span className="text-sh-gray">/</span>
        <h1 className="text-2xl font-semibold text-sh-blue">Windfall Enrichment Import</h1>
      </div>

      <p className="text-sm text-sh-gray">
        Upload the enriched customer CSV from Windfall. Matches customers by the POS code and
        imports wealth data, lifestyle signals, and philanthropy indicators.
      </p>

      <div className="flex gap-3 items-center">
        <label htmlFor="windfall-import-file" className="sr-only">
          Windfall enriched customer CSV
        </label>
        <input
          id="windfall-import-file"
          type="file"
          accept=".csv"
          onChange={handleFileChange}
          className="text-sm file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border file:border-sh-gray/30 file:bg-white file:text-sh-black file:font-semibold hover:file:bg-sh-linen file:cursor-pointer file:min-h-[44px]"
        />
        {rows.length > 0 && (
          <Button variant="primary" onClick={handleImport} disabled={importing}>
            {importing ? "Importing..." : `Import ${rows.length} rows`}
          </Button>
        )}
      </div>

      {rows.length > 0 && (
        <div className="flex gap-4 text-sm">
          <span className="text-sh-black">{rows.length} total rows</span>
          <span className="text-green-600">{matchedCount} Windfall matched</span>
          <span className="text-sh-gray">{unmatchedCount} unmatched</span>
        </div>
      )}

      {result && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-sm">
          Imported {result.imported} customers. Skipped {result.skipped} (no matching customer or no
          Windfall data).
        </div>
      )}

      {rows.length > 0 && (
        <div className="bg-white rounded-xl border border-sh-gray/15 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-sh-gray/20 bg-sh-linen">
                  <th className="text-left px-4 py-3 text-sh-gray font-semibold">Code</th>
                  <th className="text-left px-4 py-3 text-sh-gray font-semibold">Name</th>
                  <th className="text-right px-4 py-3 text-sh-gray font-semibold">Net Worth</th>
                  <th className="text-left px-4 py-3 text-sh-gray font-semibold">Tier</th>
                  <th className="text-right px-4 py-3 text-sh-gray font-semibold">Confidence</th>
                  <th className="text-left px-4 py-3 text-sh-gray font-semibold">Signals</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, PREVIEW_LIMIT).map((row, i) => {
                  const tier = computeWealthTier(row.netWorth);
                  const signals = signalsFor(row);

                  return (
                    <tr
                      key={i}
                      className={`border-b border-sh-gray/10 ${i % 2 === 1 ? "bg-sh-stripe" : ""}`}
                    >
                      <td className="px-4 py-2 font-mono text-xs">{row.customerCode}</td>
                      <td className="px-4 py-2 text-xs">{formatName(row)}</td>
                      <td className="px-4 py-2 text-right text-xs">
                        {formatNetWorth(row.netWorth)}
                      </td>
                      <td className="px-4 py-2 text-xs">
                        {tier ? (
                          <span className="px-1.5 py-0.5 rounded bg-sh-blue/10 text-sh-blue font-medium">
                            {TIER_LABELS[tier] || tier}
                          </span>
                        ) : (
                          <span className="text-sh-gray">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right text-xs">
                        {formatConfidence(row.matchConfidence)}
                      </td>
                      <td className="px-4 py-2 text-xs">
                        {signals.length > 0 ? (
                          <span className="text-sh-gray">{signals.join(", ")}</span>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {rows.length > PREVIEW_LIMIT && (
            <div className="px-4 py-3 text-center text-xs text-sh-gray border-t">
              Showing first {PREVIEW_LIMIT} of {rows.length} rows
            </div>
          )}
        </div>
      )}
    </div>
  );
}
