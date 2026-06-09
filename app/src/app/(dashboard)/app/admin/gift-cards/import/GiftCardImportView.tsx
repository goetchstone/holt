"use client";

// /app/src/app/(dashboard)/app/admin/gift-cards/import/GiftCardImportView.tsx
//
// Gift Card voucher import body. App Router port of the legacy
// admin/gift-cards/import body (minus MainLayout chrome, which the (dashboard)
// layout supplies). Parses the Voucher Report CSV client-side with papaparse and
// posts the rows to the shared /api/gift-cards/import REST endpoint.

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Upload } from "lucide-react";
import { toast } from "react-toastify";
import Papa from "papaparse";
import { Button } from "@/components/ui/button";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { getErrorMessage } from "@/lib/toastError";

interface VoucherRow {
  Creationdate: string;
  Code: string;
  Referenceno: string;
  Initialamount: string;
  Remainingamount: string;
}

interface ImportResult {
  importedCount: number;
  updatedCount: number;
  skippedCount: number;
  errorCount: number;
  errors: string[];
  totalProcessed: number;
}

export function GiftCardImportView() {
  const router = useRouter();
  const formatMoney = useMoneyFormatter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<VoucherRow[]>([]);
  const [fileName, setFileName] = useState("");
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    setResult(null);

    Papa.parse<VoucherRow>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (parsed) => {
        setRows(parsed.data);
        toast.info(`Parsed ${parsed.data.length} rows from ${file.name}`);
      },
      error: () => {
        toast.error("Failed to parse CSV file");
      },
    });
  };

  const handleImport = async () => {
    if (rows.length === 0) return;

    setImporting(true);
    try {
      const res = await fetch("/api/gift-cards/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ records: rows }),
      });

      if (res.ok) {
        const data: ImportResult = await res.json();
        setResult(data);
        toast.success(
          `Imported ${data.importedCount} new, updated ${data.updatedCount}, skipped ${data.skippedCount}`,
        );
      } else {
        toast.error(getErrorMessage(await res.json().catch(() => null), "Import failed"));
      }
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Error during import"));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="font-serif">
      <button
        onClick={() => router.push("/app/admin/gift-cards")}
        className="flex items-center gap-1 text-sh-blue font-serif mb-4 hover:underline"
      >
        <ArrowLeft className="w-4 h-4" /> Back to Gift Cards
      </button>

      <h1 className="text-2xl font-semibold text-sh-blue mb-6">Import the POS Vouchers</h1>

      {/* File upload */}
      <div className="bg-white border border-sh-gray/20 rounded-xl p-6 mb-6">
        <p className="font-serif text-sh-black mb-4">
          Upload the Voucher Report CSV. Expected columns: Creationdate, Code, Referenceno,
          Initialamount, Remainingamount.
        </p>

        <div className="flex items-center gap-3">
          <input
            ref={fileRef}
            type="file"
            accept=".csv"
            onChange={handleFileChange}
            className="hidden"
          />
          <Button
            variant="outline"
            onClick={() => fileRef.current?.click()}
            className="flex items-center gap-2"
          >
            <Upload className="w-4 h-4" /> Choose File
          </Button>
          {fileName && <span className="text-sh-gray font-serif text-sm">{fileName}</span>}
        </div>
      </div>

      {/* Preview */}
      {rows.length > 0 && !result && (
        <div className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-serif font-semibold text-sh-blue">Preview ({rows.length} rows)</h3>
            <Button onClick={handleImport} disabled={importing}>
              {importing ? "Importing..." : `Import ${rows.length} Vouchers`}
            </Button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-sh-gray/30 text-left">
                  <th className="py-2 px-3 font-serif font-semibold text-sh-blue text-sm">Date</th>
                  <th className="py-2 px-3 font-serif font-semibold text-sh-blue text-sm">Code</th>
                  <th className="py-2 px-3 font-serif font-semibold text-sh-blue text-sm">
                    Barcode
                  </th>
                  <th className="py-2 px-3 font-serif font-semibold text-sh-blue text-sm text-right">
                    Initial
                  </th>
                  <th className="py-2 px-3 font-serif font-semibold text-sh-blue text-sm text-right">
                    Remaining
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 10).map((r, i) => (
                  <tr
                    key={`${r.Referenceno || r.Code}-${i}`}
                    className={`border-b border-sh-gray/10 ${
                      i % 2 === 0 ? "bg-white" : "bg-sh-stripe"
                    }`}
                  >
                    <td className="py-2 px-3 font-serif text-sm">{r.Creationdate}</td>
                    <td className="py-2 px-3 font-serif text-sm">{r.Code}</td>
                    <td className="py-2 px-3 font-mono text-sm">{r.Referenceno}</td>
                    <td className="py-2 px-3 font-serif text-sm text-right">
                      {formatMoney(Number.parseFloat(r.Initialamount || "0"))}
                    </td>
                    <td className="py-2 px-3 font-serif text-sm text-right">
                      {formatMoney(Number.parseFloat(r.Remainingamount || "0"))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > 10 && (
              <p className="text-sh-gray font-serif text-sm text-center mt-2">
                ...and {rows.length - 10} more rows
              </p>
            )}
          </div>
        </div>
      )}

      {/* Results */}
      {result && (
        <div className="bg-white border border-sh-gray/20 rounded-xl p-6">
          <h3 className="font-serif font-semibold text-sh-blue mb-4">Import Results</h3>
          <div className="grid grid-cols-4 gap-4 mb-4">
            <div>
              <p className="text-sm text-sh-gray font-serif">Imported</p>
              <p className="text-2xl font-serif font-semibold text-green-700">
                {result.importedCount}
              </p>
            </div>
            <div>
              <p className="text-sm text-sh-gray font-serif">Updated</p>
              <p className="text-2xl font-serif font-semibold text-sh-blue">
                {result.updatedCount}
              </p>
            </div>
            <div>
              <p className="text-sm text-sh-gray font-serif">Skipped</p>
              <p className="text-2xl font-serif font-semibold text-sh-gray">
                {result.skippedCount}
              </p>
            </div>
            <div>
              <p className="text-sm text-sh-gray font-serif">Errors</p>
              <p className="text-2xl font-serif font-semibold text-red-700">{result.errorCount}</p>
            </div>
          </div>

          {result.errors.length > 0 && (
            <div className="mt-4">
              <h4 className="font-serif font-semibold text-red-700 mb-2">Errors</h4>
              <ul className="text-sm font-serif text-red-700 space-y-1">
                {result.errors.map((e, i) => (
                  <li key={`${e}-${i}`}>{e}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
