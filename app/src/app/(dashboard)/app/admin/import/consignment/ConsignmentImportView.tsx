"use client";

// /app/src/app/(dashboard)/app/admin/import/consignment/ConsignmentImportView.tsx
//
// Consignment import body (minus MainLayout chrome, which the (dashboard) layout
// supplies). Drives consignment data imports from CSV exports: backfill-from-POS
// sync, missing-item reset, vendor-return CSV import, sales-record rebuild,
// returned-rug revert, and the four chunked CSV section uploads. All work flows
// through the shared /api/consignment/* REST endpoints.

import { useId, useRef, useState, type ChangeEvent } from "react";
import Link from "next/link";
import axios from "axios";
import { toast } from "react-toastify";
import Papa from "papaparse";
import { Button } from "@/components/ui/button";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { getErrorMessage } from "@/lib/toastError";

const CHUNK_SIZE = 200;

interface ImportSection {
  title: string;
  endpoint: string;
}

const SECTIONS: ImportSection[] = [
  { title: "Consignment Items", endpoint: "/api/consignment/import/consignment-items" },
  { title: "Sales History", endpoint: "/api/consignment/import/sales" },
  { title: "Sale Line Items", endpoint: "/api/consignment/import/sales-lines" },
  { title: "Payment Lines", endpoint: "/api/consignment/import/payment-lines" },
];

export function ConsignmentImportView() {
  return (
    <div className="py-2 space-y-6 font-serif">
      <div className="flex items-center gap-3">
        <Link href="/app/admin/import" className="text-sh-blue hover:underline text-sm">
          Import Tools
        </Link>
        <span className="text-sh-gray">/</span>
        <h1 className="text-2xl font-semibold text-sh-blue">Consignment Import</h1>
      </div>

      <p className="text-sh-gray text-sm">
        Import consignment data from CSV exports (items, sales history, payments).
      </p>

      <BackfillConsignmentPanel />

      <ResetMissingPanel />

      <VendorReturnImportPanel />

      <RebuildConsignmentSalesPanel />

      <RevertReturnedRugsPanel />

      {SECTIONS.map((section) => (
        <ImportSectionPanel key={section.endpoint} section={section} />
      ))}
    </div>
  );
}

interface RebuildResult {
  salesCreated: number;
  salesUpdated: number;
  linesCreated: number;
  linesSkipped: number;
  itemsMarkedPaid: number;
  outstandingItemCount: number;
  outstandingTotal: number;
}

function RebuildConsignmentSalesPanel() {
  const formatMoney = useMoneyFormatter();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RebuildResult | null>(null);

  async function handleRebuild() {
    setRunning(true);
    setResult(null);
    try {
      const res = await axios.post<RebuildResult>("/api/consignment/import/rebuild-pos-sales");
      setResult(res.data);
      toast.success("Rebuild complete.");
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Rebuild failed."));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="bg-white rounded-lg border border-sh-gold/30 shadow-md p-5 space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-sh-black">Rebuild Sales Records</h2>
        <p className="text-sm text-sh-gray mt-1">
          Generates ConsignmentSale and ConsignmentSaleLine records from the linked SOLD items. Also
          fixes the PAID status for any items that have a payment batch assigned but are still
          showing as SOLD. Safe to run multiple times.
        </p>
      </div>

      <Button onClick={handleRebuild} disabled={running} className="min-h-[44px]">
        {running ? "Rebuilding..." : "Run Rebuild"}
      </Button>

      {result && (
        <div className="bg-sh-linen rounded-lg p-4 space-y-1 text-sm font-serif">
          <ResultRow label="Sales created:" value={result.salesCreated} />
          <ResultRow label="Sales updated:" value={result.salesUpdated} />
          <ResultRow label="Sale lines created:" value={result.linesCreated} />
          <ResultRow label="Sale lines skipped (existed):" value={result.linesSkipped} />
          <ResultRow label="Items marked PAID:" value={result.itemsMarkedPaid} />
          <div className="border-t border-sh-gray/20 pt-2 mt-2">
            <p>
              <span className="text-sh-gray">Outstanding (owed to Marjan):</span>{" "}
              <span className="font-semibold text-sh-blue">
                {result.outstandingItemCount} rugs — {formatMoney(result.outstandingTotal)}
              </span>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

interface BackfillResult {
  dryRun: boolean;
  soldSynced: number;
  paidSynced: number;
  batchesCreated: number;
  creditsDetected: number;
  details: string[];
}

function BackfillConsignmentPanel() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BackfillResult | null>(null);

  async function handleBackfill(dryRun: boolean) {
    setRunning(true);
    setResult(null);
    try {
      const url = `/api/consignment/import/backfill-from-pos${dryRun ? "?dryRun=true" : ""}`;
      const res = await axios.post<BackfillResult>(url);
      setResult(res.data);
      toast.success(dryRun ? "Dry run complete." : "Backfill complete.");
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Backfill failed."));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="bg-white rounded-lg border border-sh-gold/30 shadow-md p-5 space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-sh-black">Backfill from Sales Data</h2>
        <p className="text-sm text-sh-gray mt-1">
          Syncs ConsignmentItem statuses from the imported sales data. Marks items as SOLD from
          matching sales orders, PAID from received Marjan POs, and detects vendor credits for
          returned rugs. Run the dry run first to preview changes.
        </p>
      </div>

      <div className="flex gap-3">
        <Button
          variant="outline"
          onClick={() => handleBackfill(true)}
          disabled={running}
          className="min-h-[44px]"
        >
          {running ? "Running..." : "Dry Run (Preview)"}
        </Button>
        <Button onClick={() => handleBackfill(false)} disabled={running} className="min-h-[44px]">
          {running ? "Running..." : "Run Backfill"}
        </Button>
      </div>

      {result && (
        <div className="bg-sh-linen rounded-lg p-4 space-y-2 text-sm font-serif">
          {result.dryRun && (
            <p className="text-sh-gold font-semibold text-xs uppercase tracking-wide">
              Dry Run — no changes applied
            </p>
          )}
          <div className="space-y-1">
            <ResultRow label="Items marked SOLD:" value={result.soldSynced} />
            <ResultRow label="Items marked PAID:" value={result.paidSynced} />
            <ResultRow label="Payment batches created:" value={result.batchesCreated} />
            <ResultRow label="Vendor credits detected:" value={result.creditsDetected} />
          </div>

          {result.details.length > 0 && (
            <div className="border-t border-sh-gray/20 pt-2 mt-2">
              <p className="text-sh-gray text-xs mb-1">Details:</p>
              <div className="max-h-60 overflow-y-auto space-y-0.5">
                {result.details.map((d, i) => (
                  <p key={`${i}-${d}`} className="text-xs text-sh-black font-mono truncate">
                    {d}
                  </p>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ResetMissingPanel() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ updated: number } | null>(null);

  async function handleReset() {
    setRunning(true);
    setResult(null);
    try {
      const res = await axios.post<{ updated: number }>("/api/consignment/bulk-reset-missing");
      setResult(res.data);
      toast.success(`Reset ${res.data.updated} items to ON_FLOOR.`);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Reset failed."));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="bg-white rounded-lg border border-sh-gold/30 shadow-md p-5 space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-sh-black">Reset Missing Items</h2>
        <p className="text-sm text-sh-gray mt-1">
          Moves all MISSING consignment items back to ON_FLOOR. Use this when starting fresh with
          inventory counts.
        </p>
      </div>

      <Button onClick={handleReset} disabled={running} className="min-h-[44px]">
        {running ? "Resetting..." : "Reset All Missing to ON_FLOOR"}
      </Button>

      {result && (
        <div className="bg-sh-linen rounded-lg p-4 text-sm font-serif">
          <p>
            <span className="text-sh-gray">Items reset to ON_FLOOR:</span>{" "}
            <span className="font-semibold text-sh-blue">{result.updated}</span>
          </p>
        </div>
      )}
    </div>
  );
}

interface VendorReturnImportResult {
  returnId: number;
  itemsReturned: number;
  notFound: string[];
  alreadyReturned: string[];
}

function VendorReturnImportPanel() {
  const fileRef = useRef<HTMLInputElement>(null);
  const fileId = useId();
  const returnDateId = useId();
  const notesId = useId();
  const [barcodes, setBarcodes] = useState<string[]>([]);
  const [returnDate, setReturnDate] = useState("");
  const [notes, setNotes] = useState("");
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<VendorReturnImportResult | null>(null);

  function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setResult(null);

    Papa.parse<string[]>(file, {
      header: false,
      skipEmptyLines: true,
      complete: (results) => {
        const codes = results.data.map((row) => (row[0] || "").trim()).filter((b) => b.length > 0);
        setBarcodes(codes);
        toast.success(`Parsed ${codes.length} barcodes.`);
      },
      error: () => {
        toast.error("Failed to parse CSV.");
      },
    });
  }

  async function handleImport() {
    if (barcodes.length === 0) return;
    setImporting(true);
    setResult(null);
    try {
      const res = await axios.post<VendorReturnImportResult>(
        "/api/consignment/import/vendor-returns",
        {
          barcodes,
          returnDate: returnDate || undefined,
          notes: notes || undefined,
        },
      );
      setResult(res.data);
      toast.success(`Imported vendor return: ${res.data.itemsReturned} items.`);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Import failed."));
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="bg-white rounded-lg border border-sh-gold/30 shadow-md p-5 space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-sh-black">Import Vendor Return</h2>
        <p className="text-sm text-sh-gray mt-1">
          Upload a CSV of barcodes for rugs returned to Marjan. Creates a vendor return record
          grouping all items in the shipment.
        </p>
      </div>

      <div>
        <label htmlFor={fileId} className="block text-sm text-sh-gray mb-1">
          CSV file (barcodes in first column)
        </label>
        <input
          id={fileId}
          ref={fileRef}
          type="file"
          accept=".csv"
          onChange={handleFile}
          className="block w-full text-sm text-sh-black file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-sh-blue file:text-white hover:file:bg-sh-black file:min-h-[44px] file:cursor-pointer"
        />
      </div>

      {barcodes.length > 0 && (
        <>
          <div className="flex gap-4 items-end">
            <div>
              <label htmlFor={returnDateId} className="block text-sm text-sh-gray mb-1">
                Return Date (optional)
              </label>
              <input
                id={returnDateId}
                type="date"
                value={returnDate}
                onChange={(e) => setReturnDate(e.target.value)}
                className="border border-sh-gray/30 rounded-lg px-3 py-2 text-sm min-h-[44px]"
              />
            </div>
            <div className="flex-1">
              <label htmlFor={notesId} className="block text-sm text-sh-gray mb-1">
                Notes (optional)
              </label>
              <input
                id={notesId}
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. March 2026 return shipment"
                className="border border-sh-gray/30 rounded-lg px-3 py-2 text-sm w-full min-h-[44px]"
              />
            </div>
          </div>

          <div className="flex items-center gap-4">
            <span className="text-sm text-sh-gray">{barcodes.length} barcodes parsed</span>
            <Button onClick={handleImport} disabled={importing} className="min-h-[44px]">
              {importing ? "Importing..." : "Import Return"}
            </Button>
          </div>
        </>
      )}

      {result && (
        <div className="bg-sh-linen rounded-lg p-4 space-y-1 text-sm font-serif">
          <ResultRow label="Return record ID:" value={result.returnId} />
          <p>
            <span className="text-sh-gray">Items marked RETURNED_VENDOR:</span>{" "}
            <span className="font-semibold text-sh-blue">{result.itemsReturned}</span>
          </p>
          {result.notFound.length > 0 && (
            <div className="border-t border-sh-gray/20 pt-2 mt-2">
              <p className="text-red-600 text-xs">
                Not found ({result.notFound.length}): {result.notFound.join(", ")}
              </p>
            </div>
          )}
          {result.alreadyReturned.length > 0 && (
            <div className="border-t border-sh-gray/20 pt-2 mt-2">
              <p className="text-sh-gray text-xs">
                Already returned ({result.alreadyReturned.length}):{" "}
                {result.alreadyReturned.join(", ")}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface RevertResult {
  returnedOrdersScanned: number;
  rugBarcodesFound: number;
  itemsReverted: number;
  itemsAlreadyOnFloor: number;
}

function RevertReturnedRugsPanel() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RevertResult | null>(null);

  async function handleRevert() {
    setRunning(true);
    setResult(null);
    try {
      const res = await axios.post<RevertResult>("/api/consignment/import/revert-returned-rugs");
      setResult(res.data);
      toast.success("Revert complete.");
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Revert failed."));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="bg-white rounded-lg border border-sh-gold/30 shadow-md p-5 space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-sh-black">Revert Returned Rugs</h2>
        <p className="text-sm text-sh-gray mt-1">
          Finds all RETURNED SalesOrders, locates any matching SOLD ConsignmentItems, and flips them
          back to ON_FLOOR. Fixes historical returns that were imported before return-handling was
          added. Safe to run multiple times.
        </p>
      </div>

      <Button onClick={handleRevert} disabled={running} className="min-h-[44px]">
        {running ? "Running..." : "Run Revert"}
      </Button>

      {result && (
        <div className="bg-sh-linen rounded-lg p-4 space-y-1 text-sm font-serif">
          <ResultRow label="Returned orders scanned:" value={result.returnedOrdersScanned} />
          <ResultRow label="Rug barcodes on returned orders:" value={result.rugBarcodesFound} />
          <p>
            <span className="text-sh-gray">Items reverted to ON_FLOOR:</span>{" "}
            <span className="font-semibold text-sh-blue">{result.itemsReverted}</span>
          </p>
          <ResultRow label="Already on floor (no change):" value={result.itemsAlreadyOnFloor} />
        </div>
      )}
    </div>
  );
}

interface SectionImportState {
  success: boolean;
  message: string;
}

function ImportSectionPanel({ section }: Readonly<{ section: ImportSection }>) {
  const fileRef = useRef<HTMLInputElement>(null);
  const fileId = useId();
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState({ imported: 0, total: 0 });
  const [result, setResult] = useState<SectionImportState | null>(null);

  function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setResult(null);
    setProgress({ imported: 0, total: 0 });

    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        setRows(results.data);
        toast.success(`Parsed ${results.data.length} rows for ${section.title}.`);
      },
      error: () => {
        toast.error(`Failed to parse CSV for ${section.title}.`);
      },
    });
  }

  async function handleImport() {
    if (rows.length === 0) return;
    setImporting(true);
    setResult(null);

    const total = rows.length;
    let imported = 0;
    let errors = 0;

    setProgress({ imported: 0, total });

    for (let i = 0; i < total; i += CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CHUNK_SIZE);
      try {
        await axios.post(section.endpoint, { rows: chunk });
        imported += chunk.length;
      } catch {
        errors += chunk.length;
      }
      setProgress({ imported: imported + errors, total });
    }

    setImporting(false);
    if (errors === 0) {
      setResult({ success: true, message: `Successfully imported ${imported} rows.` });
      toast.success(`${section.title}: imported ${imported} rows.`);
    } else {
      setResult({
        success: false,
        message: `Imported ${imported} rows with ${errors} failures.`,
      });
      toast.warn(`${section.title}: ${errors} rows failed.`);
    }
  }

  return (
    <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-5 space-y-4">
      <h2 className="text-lg font-semibold text-sh-black">{section.title}</h2>

      <div>
        <label htmlFor={fileId} className="block text-sm text-sh-gray mb-1">
          Upload CSV
        </label>
        <input
          id={fileId}
          ref={fileRef}
          type="file"
          accept=".csv"
          onChange={handleFile}
          className="block w-full text-sm text-sh-black file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-sh-blue file:text-white hover:file:bg-sh-black file:min-h-[44px] file:cursor-pointer"
        />
      </div>

      {rows.length > 0 && (
        <div className="flex items-center gap-4">
          <span className="text-sm text-sh-gray">{rows.length} rows parsed</span>
          <Button onClick={handleImport} disabled={importing} className="min-h-[44px]">
            {importing ? "Importing..." : "Import"}
          </Button>
        </div>
      )}

      {importing && progress.total > 0 && (
        <div className="space-y-1">
          <div className="w-full bg-gray-200 rounded-full h-2">
            <div
              className="bg-sh-blue h-2 rounded-full transition-all"
              style={{ width: `${(progress.imported / progress.total) * 100}%` }}
            />
          </div>
          <span className="text-xs text-sh-gray">
            {progress.imported} of {progress.total}
          </span>
        </div>
      )}

      {result && (
        <div
          className={`text-sm font-medium ${result.success ? "text-green-700" : "text-red-600"}`}
        >
          {result.message}
        </div>
      )}
    </div>
  );
}

function ResultRow({ label, value }: Readonly<{ label: string; value: number }>) {
  return (
    <p>
      <span className="text-sh-gray">{label}</span> <span className="font-semibold">{value}</span>
    </p>
  );
}
