"use client";

// /app/src/app/(dashboard)/app/admin/import/inventory-snapshot/InventorySnapshotImportView.tsx
//
// Inventory snapshot import body. App Router port of the legacy
// admin/import/inventory-snapshot body (minus MainLayout chrome, which the
// (dashboard) layout supplies). Clears the prior snapshot, parses the CSV
// client-side, then uploads in chunks against the shared
// /api/inventory/clear-snapshot + /api/import/inventory-snapshot REST endpoints.

import { useState, type ChangeEvent } from "react";
import Papa from "papaparse";

const CHUNK_SIZE = 500;

type ImportStatus = "idle" | "clearing" | "parsing" | "uploading" | "done" | "error";

type SnapshotRecord = Record<string, unknown>;

interface ErrorDetail {
  message: string;
  data?: unknown;
}

interface ChunkResult {
  created: number;
  errors: number;
  errorDetails: ErrorDetail[];
}

interface ImportSummary {
  created: number;
  errors: number;
  errorDetails: ErrorDetail[];
}

interface SnapshotApiResponse {
  createdCount?: number;
  errorCount?: number;
  errors?: ErrorDetail[];
}

const RUNNING_STATUSES: ImportStatus[] = ["clearing", "parsing", "uploading"];

// Stable, outside-of-component helper so the upload loop stays shallow.
async function processChunk(chunk: SnapshotRecord[]): Promise<ChunkResult> {
  try {
    const response = await fetch("/api/import/inventory-snapshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ records: chunk }),
    });
    if (!response.ok) {
      const errorData = (await response.json().catch(() => ({}))) as { error?: string };
      // Summarize errors rather than echoing the full list, for stability.
      return {
        created: 0,
        errors: chunk.length,
        errorDetails: [{ message: errorData.error || "Server processing error" }],
      };
    }
    const data = (await response.json()) as SnapshotApiResponse;
    return {
      created: data.createdCount || 0,
      errors: data.errorCount || 0,
      errorDetails: data.errors || [],
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      created: 0,
      errors: chunk.length,
      errorDetails: [{ message: `Network error: ${message}` }],
    };
  }
}

function importButtonLabel(status: ImportStatus, progress: number, total: number): string {
  switch (status) {
    case "clearing":
      return "Clearing...";
    case "parsing":
      return "Parsing File...";
    case "uploading":
      return `Importing... ${progress}/${total}`;
    case "done":
      return "Finished";
    case "error":
      return "Error Occurred";
    default:
      return "Clear and Import";
  }
}

export function InventorySnapshotImportView() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<ImportStatus>("idle");
  const [progress, setProgress] = useState(0);
  const [totalRecords, setTotalRecords] = useState(0);
  const [finalResult, setFinalResult] = useState<ImportSummary>({
    created: 0,
    errors: 0,
    errorDetails: [],
  });

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    setFile(event.target.files ? event.target.files[0] : null);
    setStatus("idle");
    setProgress(0);
    setTotalRecords(0);
    setFinalResult({ created: 0, errors: 0, errorDetails: [] });
  };

  const handleImport = async () => {
    if (!file) return;

    setStatus("clearing");
    setProgress(0);
    setTotalRecords(0);
    setFinalResult({ created: 0, errors: 0, errorDetails: [] });

    // 1. CLEAR
    const clearResponse = await fetch("/api/inventory/clear-snapshot", { method: "POST" });
    if (!clearResponse.ok) {
      setStatus("error");
      setFinalResult({
        created: 0,
        errors: 0,
        errorDetails: [{ message: "Failed to clear previous data." }],
      });
      return;
    }

    // 2. PARSE
    setStatus("parsing");
    const records = await new Promise<SnapshotRecord[]>((resolve) => {
      Papa.parse<SnapshotRecord>(file, {
        header: true,
        skipEmptyLines: true,
        dynamicTyping: true,
        complete: (results) => resolve(results.data),
      });
    });

    setTotalRecords(records.length);
    setStatus("uploading");

    // 3. UPLOAD IN CHUNKS
    let totalCreated = 0;
    let allErrors: ErrorDetail[] = [];

    for (let i = 0; i < records.length; i += CHUNK_SIZE) {
      const chunk = records.slice(i, i + CHUNK_SIZE);
      const result = await processChunk(chunk);

      totalCreated += result.created;
      allErrors = [...allErrors, ...result.errorDetails];

      setProgress(i + chunk.length);
    }

    // 4. DONE
    setFinalResult({ created: totalCreated, errors: allErrors.length, errorDetails: allErrors });
    setStatus("done");
  };

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-4">Import Inventory Snapshot</h1>
      <div className="flex items-center space-x-4">
        <label htmlFor="inventory-snapshot-file" className="sr-only">
          Inventory snapshot CSV
        </label>
        <input id="inventory-snapshot-file" type="file" accept=".csv" onChange={handleFileChange} />
        <button
          type="button"
          onClick={handleImport}
          disabled={RUNNING_STATUSES.includes(status) || !file}
          className="bg-blue-600 text-white px-4 py-2 rounded-md disabled:bg-gray-400"
        >
          {importButtonLabel(status, progress, totalRecords)}
        </button>
      </div>

      {status !== "idle" && (
        <div className="mt-6 p-4 border rounded-lg bg-gray-50">
          <h2 className="font-semibold text-lg">Import Status</h2>
          <ImportStatusLine status={status} />

          <p>
            <strong>Rows Imported Successfully:</strong> {finalResult.created}
          </p>
          <p>
            <strong>Rows with Errors:</strong> {finalResult.errors}
          </p>

          {finalResult.errors > 0 && (
            <div className="mt-4">
              <h3 className="font-semibold text-red-700">Error Details:</h3>
              <ul className="list-disc pl-5 mt-2 max-h-60 overflow-y-auto text-sm bg-red-50 p-2 rounded">
                {finalResult.errorDetails.map((err, index) => (
                  <li key={index} className="mb-1">
                    {err.message}
                    {err.data != null && (
                      <pre className="text-xs bg-red-100 p-1 mt-1 rounded">
                        {JSON.stringify(err.data)}
                      </pre>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ImportStatusLine({ status }: Readonly<{ status: ImportStatus }>) {
  if (status === "done") return <p className="text-green-600 font-bold">Import complete.</p>;
  if (status === "error") return <p className="text-red-600 font-bold">Import failed.</p>;
  return <p>Process running, please wait...</p>;
}
