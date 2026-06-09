"use client";

// /app/src/app/(dashboard)/app/admin/import/data/GenericImportView.tsx
//
// Generic configurable CSV importer body. App Router port of the legacy
// admin/import/data body (minus MainLayout chrome, which the (dashboard) layout
// supplies). Pick what you're importing, upload a spreadsheet from any system,
// map its columns onto the entity's fields, then import in batches against the
// shared /api/import/generic REST endpoint.

import { useMemo, useState } from "react";
import Papa from "papaparse";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";
import {
  IMPORT_ENTITIES,
  getImportEntity,
  suggestMapping,
  type ColumnMapping,
  type GenericImportResult,
} from "@/lib/genericImport";

type CsvRow = Record<string, string>;

const BATCH_SIZE = 500;
const PREVIEW_ROWS = 5;

function rowHasData(row: CsvRow): boolean {
  return Object.values(row).some((v) => v != null && String(v).trim() !== "");
}

function pluralRows(count: number): string {
  return `${count} row${count === 1 ? "" : "s"}`;
}

function importButtonLabel(
  importing: boolean,
  rowCount: number,
  progress: { done: number; total: number } | null,
): string {
  if (!importing) return `Import ${pluralRows(rowCount)}`;
  return progress ? `Importing… ${progress.done}/${progress.total}` : "Importing…";
}

export function GenericImportView() {
  const [entityKey, setEntityKey] = useState<string>(IMPORT_ENTITIES[0].key);
  const [fileName, setFileName] = useState<string>("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<CsvRow[]>([]);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<GenericImportResult | null>(null);

  const entity = getImportEntity(entityKey)!;

  const requiredUnmapped = useMemo(
    () => entity.fields.filter((f) => f.required && !mapping[f.key]),
    [entity, mapping],
  );

  const mappedFields = useMemo(
    () => entity.fields.filter((f) => mapping[f.key]),
    [entity, mapping],
  );

  const resetData = () => {
    setFileName("");
    setHeaders([]);
    setRows([]);
    setMapping({});
    setResult(null);
    setProgress(null);
  };

  const handleEntityChange = (key: string) => {
    setEntityKey(key);
    resetData();
  };

  const handleFile = (file: File | undefined) => {
    if (!file) return;
    setResult(null);
    Papa.parse<CsvRow>(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim(),
      complete: (res) => {
        const fields = (res.meta.fields || []).filter((f) => f && f.trim() !== "");
        const data = (res.data || []).filter(rowHasData);
        if (fields.length === 0 || data.length === 0) {
          toast.warn("That file has no readable rows.");
          return;
        }
        setFileName(file.name);
        setHeaders(fields);
        setRows(data);
        setMapping(suggestMapping(fields, entity));
      },
      error: () => toast.error("Could not read that file."),
    });
  };

  const setFieldMapping = (fieldKey: string, header: string) => {
    setMapping((prev) => ({ ...prev, [fieldKey]: header || null }));
  };

  const handleImport = async () => {
    if (rows.length === 0 || requiredUnmapped.length > 0) return;
    setImporting(true);
    setResult(null);
    setProgress({ done: 0, total: rows.length });
    const acc: GenericImportResult = { imported: 0, skipped: 0, errors: [] };
    try {
      for (let start = 0; start < rows.length; start += BATCH_SIZE) {
        const batch = rows.slice(start, start + BATCH_SIZE);
        const res = await fetch("/api/import/generic", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entity: entityKey, mapping, rows: batch }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error || `Import failed (${res.status})`);
        }
        const data = (await res.json()) as GenericImportResult;
        acc.imported += data.imported;
        acc.skipped += data.skipped;
        acc.errors.push(...data.errors);
        setProgress({ done: Math.min(start + BATCH_SIZE, rows.length), total: rows.length });
      }
      setResult(acc);
      toast.success(`Imported ${acc.imported} ${entity.label.toLowerCase()}.`);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Import failed."));
    } finally {
      setImporting(false);
      setProgress(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-serif text-sh-navy">Import Data</h1>
        <p className="mt-1 text-sm text-sh-gray">
          Upload a spreadsheet exported from any system and map its columns to the fields below.
        </p>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-sh-navy">What are you importing?</legend>
        <div className="flex flex-wrap gap-2">
          {IMPORT_ENTITIES.map((e) => (
            <button
              key={e.key}
              type="button"
              onClick={() => handleEntityChange(e.key)}
              className={`min-h-[44px] rounded border px-4 text-sm transition-colors ${
                e.key === entityKey
                  ? "border-sh-navy bg-sh-navy text-white"
                  : "border-gray-300 bg-white text-sh-navy hover:bg-sh-linen"
              }`}
            >
              {e.label}
            </button>
          ))}
        </div>
        <p className="text-sm text-sh-gray">{entity.description}</p>
      </fieldset>

      <div className="rounded-lg border border-gray-200 p-4">
        <label htmlFor="generic-import-file" className="block text-sm font-medium text-sh-navy">
          CSV file
        </label>
        <input
          id="generic-import-file"
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => handleFile(e.target.files?.[0])}
          className="mt-2 block w-full text-sm text-sh-gray file:mr-4 file:min-h-[44px] file:rounded file:border-0 file:bg-sh-navy file:px-4 file:text-sm file:text-white hover:file:bg-sh-navy/90"
        />
        {fileName && (
          <p className="mt-2 text-xs text-sh-gray">
            {fileName} — {pluralRows(rows.length)}
          </p>
        )}
      </div>

      {headers.length > 0 && (
        <>
          <div className="rounded-lg border border-gray-200 overflow-hidden">
            <div className="bg-sh-linen px-4 py-3">
              <h2 className="text-sm font-medium text-sh-navy">Map columns</h2>
              <p className="text-xs text-sh-gray">
                We matched your columns automatically. Adjust any that are wrong.
              </p>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs text-sh-gray">
                  <th className="px-4 py-2 font-medium">Field</th>
                  <th className="px-4 py-2 font-medium">Your column</th>
                </tr>
              </thead>
              <tbody>
                {entity.fields.map((field, i) => (
                  <tr
                    key={field.key}
                    className={`border-b border-gray-100 ${i % 2 === 1 ? "bg-sh-stripe" : "bg-white"}`}
                  >
                    <td className="px-4 py-3 align-top">
                      <label htmlFor={`map-${field.key}`} className="font-medium text-sh-navy">
                        {field.label}
                        {field.required && <span className="ml-1 text-red-600">*</span>}
                      </label>
                      {field.help && <p className="mt-0.5 text-xs text-sh-gray">{field.help}</p>}
                    </td>
                    <td className="px-4 py-3">
                      <select
                        id={`map-${field.key}`}
                        value={mapping[field.key] ?? ""}
                        onChange={(e) => setFieldMapping(field.key, e.target.value)}
                        className="min-h-[44px] w-full rounded border border-gray-300 px-3 text-sm"
                      >
                        <option value="">— Skip —</option>
                        {headers.map((h) => (
                          <option key={h} value={h}>
                            {h}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {requiredUnmapped.length > 0 && (
            <p className="text-sm text-red-600">
              Map a column for: {requiredUnmapped.map((f) => f.label).join(", ")}.
            </p>
          )}

          {mappedFields.length > 0 && (
            <div className="rounded-lg border border-gray-200 overflow-x-auto">
              <div className="bg-sh-linen px-4 py-3">
                <h2 className="text-sm font-medium text-sh-navy">
                  Preview (first {Math.min(PREVIEW_ROWS, rows.length)} rows)
                </h2>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-left text-xs text-sh-gray">
                    {mappedFields.map((f) => (
                      <th key={f.key} className="whitespace-nowrap px-4 py-2 font-medium">
                        {f.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, PREVIEW_ROWS).map((row, idx) => (
                    <tr
                      key={idx}
                      className={`border-b border-gray-100 ${idx % 2 === 1 ? "bg-sh-stripe" : "bg-white"}`}
                    >
                      {mappedFields.map((f) => (
                        <td key={f.key} className="whitespace-nowrap px-4 py-2 text-sh-navy">
                          {row[mapping[f.key] as string] ?? ""}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex items-center gap-4">
            <Button onClick={handleImport} disabled={importing || requiredUnmapped.length > 0}>
              {importButtonLabel(importing, rows.length, progress)}
            </Button>
          </div>
        </>
      )}

      {result && (
        <div className="rounded-lg border border-gray-200 p-4">
          <p className="text-sm text-sh-navy">
            Imported <span className="font-medium">{result.imported}</span>, skipped{" "}
            <span className="font-medium">{result.skipped}</span>.
          </p>
          {result.errors.length > 0 && (
            <div className="mt-3">
              <p className="text-sm font-medium text-red-600">
                {pluralRows(result.errors.length)} had errors:
              </p>
              <ul className="mt-1 list-inside list-disc text-xs text-sh-gray">
                {result.errors.slice(0, 10).map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
                {result.errors.length > 10 && <li>…and {result.errors.length - 10} more.</li>}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
