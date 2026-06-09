"use client";

// /app/src/app/(dashboard)/app/inventory/consignment/receive/ReceiveView.tsx
//
// Receive Consignment Shipment body: upload a vendor manifest (XLS/XLSX), parse
// it client-side into a preview table (deriving anchor = cost × 7 and retail =
// cost × 7 / 2), pick a receiving location, then import. App Router port of the
// legacy inventory/consignment/receive body (minus MainLayout chrome). Reads
// /api/warehouse/locations and posts to /api/consignment/import/manifest; money
// uses the tenant formatter. Pricing math is copied verbatim from the legacy
// page.

import { useState, useRef, useEffect, useCallback, type ChangeEvent } from "react";
import Link from "next/link";
import axios from "axios";
import { toast } from "react-toastify";
import * as XLSX from "xlsx";
import { Button } from "@/components/ui/button";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { getErrorMessage } from "@/lib/toastError";

interface StoreLocationOption {
  id: number;
  name: string;
  code: string;
}

interface ParsedRow {
  rowNumber: number;
  rugNumber: string;
  customerNumber: string;
  baleNumber: string;
  quality: string;
  size: string;
  cost: number;
  anchorPrice: number;
  retailPrice: number;
}

interface ImportError {
  row: number;
  rugNumber: string | null;
  error: string;
}

interface ImportResult {
  success: boolean;
  message: string;
  imported?: number;
  errors?: ImportError[];
}

function findCol(row: Record<string, string>, keys: string[], target: string): string {
  const key = keys.find((k) => k.trim().toUpperCase().includes(target.toUpperCase()));
  return key ? String(row[key]).trim() : "";
}

function buildSize(row: Record<string, string>, keys: string[]): string {
  const sizeIdx = keys.findIndex((k) => k.trim().toUpperCase().includes("SIZE"));
  if (sizeIdx < 0) return "";

  const parts: string[] = [];
  for (let i = sizeIdx; i < keys.length; i++) {
    const val = String(row[keys[i]]).trim();
    if (i > sizeIdx && keys[i].trim() !== "" && !keys[i].startsWith("__EMPTY")) {
      break;
    }
    if (val && val !== "undefined") {
      parts.push(val);
    }
  }

  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function resultColor(result: ImportResult): string {
  if (result.success) return "text-green-700";
  if (result.errors && result.errors.length > 0) return "text-amber-600";
  return "text-red-600";
}

export function ReceiveView() {
  const fmt = useMoneyFormatter();

  const fileRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [manifestRef, setManifestRef] = useState("");
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [storeLocations, setStoreLocations] = useState<StoreLocationOption[]>([]);
  const [storeLocationId, setStoreLocationId] = useState<number | "">("");

  const loadLocations = useCallback(async () => {
    try {
      const res = await axios.get("/api/warehouse/locations?isActive=true");
      const locs: StoreLocationOption[] = (res.data.locations || []).map(
        (l: { id: number; name: string; code: string }) => ({
          id: l.id,
          name: l.name,
          code: l.code,
        }),
      );
      setStoreLocations(locs);
      // Default to first STORE-type location
      if (locs.length > 0) {
        setStoreLocationId(locs[0].id);
      }
    } catch {
      // Locations are non-critical for the page to load
    }
  }, []);

  useEffect(() => {
    loadLocations();
  }, [loadLocations]);

  function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setResult(null);

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const data = new Uint8Array(evt.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: "array" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const raw: Record<string, string>[] = XLSX.utils.sheet_to_json(sheet, { defval: "" });

        const parsed = raw.map((row, i) => {
          const keys = Object.keys(row);

          const rugNumber = findCol(row, keys, "RUG NO.") || findCol(row, keys, "RUG NO");
          const customerNumber = findCol(row, keys, "CUST. #") || findCol(row, keys, "CUST.#");
          const baleNumber = findCol(row, keys, "BALE");
          const quality = findCol(row, keys, "QUALITY");
          const costStr = findCol(row, keys, "PRICE");
          const cost = Number.parseFloat(String(costStr).replace(/[^0-9.]/g, "")) || 0;

          const size = buildSize(row, keys);

          const anchorPrice = Math.round(cost * 7 * 100) / 100;
          const retailPrice = Math.round(((cost * 7) / 2) * 100) / 100;

          return {
            rowNumber: i + 1,
            rugNumber: String(rugNumber),
            customerNumber: String(customerNumber),
            baleNumber: String(baleNumber),
            quality: String(quality),
            size,
            cost,
            anchorPrice,
            retailPrice,
          };
        });

        setRows(parsed.filter((r) => r.rugNumber || r.quality));
        toast.success(`Parsed ${parsed.length} rows.`);
      } catch {
        toast.error("Failed to parse file.");
      }
    };
    reader.readAsArrayBuffer(file);
  }

  async function handleImport() {
    if (rows.length === 0) return;
    setImporting(true);
    setResult(null);
    try {
      const res = await axios.post("/api/consignment/import/manifest", {
        manifestReference: manifestRef || undefined,
        storeLocationId: storeLocationId || undefined,
        items: rows.map((r) => ({
          rugNumber: r.rugNumber,
          customerNumber: r.customerNumber,
          baleNumber: r.baleNumber,
          quality: r.quality,
          size: r.size,
          cost: r.cost,
        })),
      });
      const errCount = res.data.errors?.length ?? 0;
      const imported = res.data.imported ?? rows.length;
      const msg =
        errCount > 0
          ? `Imported ${imported} of ${rows.length} items. ${errCount} failed.`
          : `Imported ${imported} items.`;
      setResult({ success: errCount === 0, message: msg, imported, errors: res.data.errors });
      if (errCount > 0) {
        toast.warn(msg);
      } else {
        toast.success("Import complete.");
      }
    } catch (err: unknown) {
      const msg = getErrorMessage(err, "Import failed.");
      setResult({ success: false, message: msg });
      toast.error(msg);
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="py-2 space-y-6 font-serif">
      <div className="flex items-center gap-3">
        <Link href="/app/inventory/consignment" className="text-sh-blue hover:underline text-sm">
          Consignment
        </Link>
        <span className="text-sh-gray">/</span>
        <h1 className="text-2xl font-semibold text-sh-blue">Receive Shipment</h1>
      </div>

      <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-5 space-y-4">
        <div>
          <label htmlFor="manifest-file" className="block text-sm text-sh-gray mb-1">
            Upload Vendor Manifest (XLS/XLSX)
          </label>
          <input
            id="manifest-file"
            ref={fileRef}
            type="file"
            accept=".xls,.xlsx"
            onChange={handleFile}
            className="block w-full text-sm text-sh-black file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-sh-blue file:text-white hover:file:bg-sh-black file:min-h-[44px] file:cursor-pointer"
          />
        </div>

        {rows.length > 0 && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="receiving-location" className="block text-sm text-sh-gray mb-1">
                Receiving Location
              </label>
              <select
                id="receiving-location"
                value={storeLocationId}
                onChange={(e) => setStoreLocationId(e.target.value ? Number(e.target.value) : "")}
                className="border border-sh-gray/40 rounded-lg px-3 min-h-[44px] w-full font-serif text-sh-black"
              >
                <option value="">Select store location</option>
                {storeLocations.map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    {loc.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="manifest-reference" className="block text-sm text-sh-gray mb-1">
                Manifest Reference
              </label>
              <input
                id="manifest-reference"
                type="text"
                value={manifestRef}
                onChange={(e) => setManifestRef(e.target.value)}
                placeholder="Optional reference number"
                className="border border-sh-gray/40 rounded-lg px-3 min-h-[44px] w-full font-serif text-sh-black"
              />
            </div>
          </div>
        )}
      </div>

      {rows.length > 0 && (
        <>
          <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-sh-gray/20 bg-sh-linen">
                    <th className="text-left px-4 py-3 text-sh-gray font-semibold">Row</th>
                    <th className="text-left px-4 py-3 text-sh-gray font-semibold">Rug Number</th>
                    <th className="text-left px-4 py-3 text-sh-gray font-semibold">Customer #</th>
                    <th className="text-left px-4 py-3 text-sh-gray font-semibold">Quality</th>
                    <th className="text-left px-4 py-3 text-sh-gray font-semibold">Size</th>
                    <th className="text-right px-4 py-3 text-sh-gray font-semibold">Cost</th>
                    <th className="text-right px-4 py-3 text-sh-gray font-semibold">Anchor</th>
                    <th className="text-right px-4 py-3 text-sh-gray font-semibold">Retail</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.rowNumber}
                      className={`border-b border-sh-gray/10 ${
                        row.rowNumber % 2 === 0 ? "bg-sh-stripe" : ""
                      }`}
                    >
                      <td className="px-4 py-3 text-sh-gray">{row.rowNumber}</td>
                      <td className="px-4 py-3 text-sh-black">{row.rugNumber}</td>
                      <td className="px-4 py-3 text-sh-black">{row.customerNumber}</td>
                      <td className="px-4 py-3 text-sh-black">{row.quality}</td>
                      <td className="px-4 py-3 text-sh-black">{row.size}</td>
                      <td className="px-4 py-3 text-sh-black text-right">{fmt(row.cost)}</td>
                      <td className="px-4 py-3 text-sh-black text-right">{fmt(row.anchorPrice)}</td>
                      <td className="px-4 py-3 text-sh-black text-right">{fmt(row.retailPrice)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center gap-4">
              <Button onClick={handleImport} disabled={importing} className="min-h-[44px]">
                {importing ? "Importing..." : `Import ${rows.length} Items`}
              </Button>
              {result && (
                <span className={`text-sm font-medium ${resultColor(result)}`}>
                  {result.message}
                </span>
              )}
            </div>
            {result?.errors && result.errors.length > 0 && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4 space-y-1">
                <p className="text-sm font-semibold text-red-700">Failed rows:</p>
                {result.errors.map((e) => (
                  <p
                    key={`${e.row}-${e.rugNumber ?? "unknown"}`}
                    className="text-xs text-red-600 font-mono"
                  >
                    Row {e.row} ({e.rugNumber ?? "unknown"}): {e.error}
                  </p>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
