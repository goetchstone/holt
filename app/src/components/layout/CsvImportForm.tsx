"use client";

// /app/src/components/layout/CsvImportForm.tsx
//
// Chrome-free CSV import form for App Router admin/import pages: file input ->
// PapaParse -> caller normalize -> preview table -> import. No MainLayout chrome
// -- the (dashboard) layout supplies it. Each caller passes a normalize function
// that maps raw CSV rows to its typed shape and an onImport handler that POSTs
// to the REST API.

import { useState, type ChangeEvent } from "react";
import Papa from "papaparse";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";

// Module-level helper so the parse callback chain stays shallow.
function rowHasValue(row: unknown): boolean {
  return Object.values(row as Record<string, unknown>).some((val) => String(val).trim() !== "");
}

export interface CsvColumnHeader<T> {
  key: keyof T;
  label: string;
}

interface CsvImportFormProps<T> {
  title: string;
  /** Maps the raw parsed CSV rows to the caller's typed, filtered shape. */
  normalize: (rows: Record<string, unknown>[]) => T[];
  columnHeaders: CsvColumnHeader<T>[];
  /** Imports the previewed rows. Resolves true to clear the preview on success. */
  onImport: (rows: T[]) => Promise<boolean>;
}

export default function CsvImportForm<T>({
  title,
  normalize,
  columnHeaders,
  onImport,
}: Readonly<CsvImportFormProps<T>>) {
  const [parsedData, setParsedData] = useState<T[]>([]);
  const [uploading, setUploading] = useState(false);
  const inputId = `csv-import-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const importLabel = title.split(" ").pop() ?? "Data";

  const handleFileUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const uploadedFile = e.target.files?.[0];
    if (!uploadedFile) {
      setParsedData([]);
      return;
    }
    setUploading(false);

    Papa.parse<Record<string, unknown>>(uploadedFile, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h: string) => h.trim(),
      complete: (results) => {
        const rows = results.data.filter(rowHasValue);
        const normalized = normalize(rows);
        setParsedData(normalized);
        if (normalized.length > 0) {
          toast.info(`Parsed ${normalized.length} rows. Review and click Import.`);
        }
      },
      error: (error: unknown) => {
        toast.error(
          `Error parsing file: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
        setParsedData([]);
      },
    });
  };

  const handleImport = async () => {
    setUploading(true);
    try {
      const cleared = await onImport(parsedData);
      if (cleared) setParsedData([]);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-6 py-2 font-serif">
      <h1 className="text-2xl font-semibold text-sh-blue">{title}</h1>

      <div className="flex items-center gap-4">
        <input
          id={inputId}
          type="file"
          accept=".csv"
          onChange={handleFileUpload}
          className="block w-full text-sm text-sh-black
            file:mr-4 file:rounded-lg file:border-0 file:bg-sh-blue file:px-4 file:py-2
            file:text-sm file:font-semibold file:text-white hover:file:bg-sh-black"
        />
        <Button
          onClick={handleImport}
          disabled={uploading || parsedData.length === 0}
          variant="primary"
        >
          {uploading ? "Importing..." : `Import ${importLabel}`}
        </Button>
      </div>

      {parsedData.length > 0 && (
        <div>
          <h2 className="mb-2 text-xl font-semibold">Preview ({parsedData.length} rows):</h2>
          <div className="overflow-x-auto rounded-lg border border-sh-gray shadow-sm">
            <table className="min-w-full whitespace-nowrap text-left text-sm">
              <thead className="bg-sh-linen text-sh-black">
                <tr>
                  {columnHeaders.map((header) => (
                    <th key={String(header.key)} className="border-b border-sh-gray p-2">
                      {header.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {parsedData.map((row, i) => (
                  <tr key={i} className="odd:bg-white even:bg-sh-stripe">
                    {columnHeaders.map((header) => (
                      <td key={String(header.key)} className="border-b border-sh-gray p-2">
                        {String(row[header.key] ?? "")}
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
