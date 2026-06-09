"use client";

// /app/src/app/(dashboard)/app/admin/pricing/import/PricingImportView.tsx
//
// Generic vendor price book import wizard body. App Router port of the legacy
// admin/pricing/import/index body (minus MainLayout chrome, which the
// (dashboard) layout supplies). Pick a vendor + import type, upload a PDF / CSV
// / XLSX, preview the parsed rows, then commit against the shared /api/pricing/*
// REST endpoints. The parse + import endpoints stay REST. Reads ?vendor= from
// the URL to auto-select a vendor.

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import StepTabs, { StepTabPanel, type StepTabDefinition } from "@/components/ui/StepTabs";
import ImportPreview from "@/components/pricing/ImportPreview";
import FormDropdown from "@/components/form/FormDropdown";
import {
  type ParsedWholesaleProduct,
  type ParsedFoundationsProduct,
  parseWholesaleRows,
  parseFoundationsRows,
  parseFabricRows as parseFabricRowsShared,
  type ParsedFabricRow,
} from "@/lib/pricing/wesleyHallParser";
import type { ParseDiagnostic } from "@/lib/pricing/pricingTypes";
import { getErrorMessage } from "@/lib/toastError";
import { toast } from "react-toastify";
import axios from "axios";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import {
  Upload,
  FileText,
  CheckCircle,
  AlertTriangle,
  Loader2,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

// ─── Types ─────────────────────────────────────────────────────────

interface ImportTypeConfig {
  value: string;
  label: string;
  defaultPriceListName: string;
  /** API endpoint for import. Defaults to wholesale-prices. */
  importEndpoint?: string;
}

interface VendorConfig {
  slug: string;
  /** Lowercase substring to match against vendor.name from the DB */
  nameMatch: string;
  displayName: string;
  importTypes: ImportTypeConfig[];
}

interface VendorOption {
  id: number;
  name: string;
}

type FabricRow = ParsedFabricRow;
type ParsedProduct = ParsedWholesaleProduct | ParsedFoundationsProduct | FabricRow;

/** Superset of the structured shapes parse-pdf returns for grouped vendors
 *  (Kingsley Bate, Brown Jordan, Summer Classics, Jensen, Ekornes, American
 *  Leather). Every field is optional because each vendor populates a subset; the
 *  preview + import endpoints read the relevant ones by vendor. */
interface ParsedVendorData {
  frames?: unknown[];
  cushions?: unknown[];
  covers?: unknown[];
  fabrics?: unknown[];
  finishes?: unknown[];
  seating?: unknown[];
  tables?: unknown[];
  products?: unknown[];
  collections?: unknown[];
}

interface ImportResult {
  success?: boolean;
  importedCount?: number;
  created?: number;
  skippedCount?: number;
  skipped?: number;
  errors?: string[];
}

interface ImageExtractionResult {
  imagesExtracted?: number;
  stylesMapped?: number;
  stylesUpdated?: number;
  pageNumberBase?: number;
  pagesMatched?: number;
  pagesWithImages?: number;
  error?: string;
  details?: string;
}

type ImportStep = "upload" | "preview" | "import";

// ─── Vendor configuration registry ─────────────────────────────────

const VENDOR_CONFIGS: VendorConfig[] = [
  {
    slug: "wesley-hall",
    nameMatch: "wesley hall",
    displayName: "Wesley Hall",
    importTypes: [
      {
        value: "wholesale",
        label: "Wholesale Price Book",
        defaultPriceListName: "Wesley Hall Wholesale October 2025",
      },
      {
        value: "foundations",
        label: "Foundations Program",
        defaultPriceListName: "Wesley Hall Foundations Program",
        importEndpoint: "/api/pricing/import/foundations",
      },
      {
        value: "fabrics",
        label: "Fabric Catalog",
        defaultPriceListName: "Wesley Hall Fabric Catalog",
        importEndpoint: "/api/pricing/import/fabrics",
      },
      {
        value: "signature-elements",
        label: "Signature Elements",
        defaultPriceListName: "Wesley Hall Signature Elements October 2025",
        importEndpoint: "/api/pricing/import/signature-elements",
      },
    ],
  },
  {
    slug: "c-r-laine",
    nameMatch: "c r laine",
    displayName: "C R Laine",
    importTypes: [
      {
        value: "wholesale",
        label: "Wholesale Price List",
        defaultPriceListName: "C R Laine Wholesale September 2025",
      },
      {
        value: "simplicity",
        label: "Simplicity Program",
        defaultPriceListName: "C R Laine Simplicity October 2025",
        importEndpoint: "/api/pricing/import/foundations",
      },
      {
        value: "fabrics",
        label: "Fabric Catalog",
        defaultPriceListName: "C R Laine Fabric Catalog",
        importEndpoint: "/api/pricing/import/fabrics",
      },
    ],
  },
  {
    slug: "caperton",
    nameMatch: "caperton",
    displayName: "Gat Creek (Caperton)",
    importTypes: [
      {
        value: "wholesale",
        label: "Wholesale Price List",
        defaultPriceListName: "Gat Creek Wholesale January 2026",
        importEndpoint: "/api/pricing/import/wood-prices",
      },
    ],
  },
  {
    slug: "kingsley-bate",
    nameMatch: "kingsley bate",
    displayName: "Kingsley Bate",
    importTypes: [
      {
        value: "retail-prices",
        label: "Retail Price List",
        defaultPriceListName: "Kingsley Bate Retail March 2026",
        importEndpoint: "/api/pricing/import/frame-cushion-prices",
      },
    ],
  },
  {
    slug: "brown-jordan",
    nameMatch: "brown jordan",
    displayName: "Brown Jordan",
    importTypes: [
      {
        value: "retail-prices",
        label: "Retail Price List",
        defaultPriceListName: "Brown Jordan Retail 2026",
        importEndpoint: "/api/pricing/import/retail-grade-prices",
      },
    ],
  },
  {
    slug: "summer-classics",
    nameMatch: "summer classics",
    displayName: "Summer Classics",
    importTypes: [
      {
        value: "wholesale",
        label: "Wholesale Price List",
        defaultPriceListName: "Summer Classics Wholesale August 2025",
        importEndpoint: "/api/pricing/import/summer-classics-prices",
      },
    ],
  },
  {
    slug: "jensen-leisure",
    nameMatch: "jensen",
    displayName: "Jensen Leisure",
    importTypes: [
      {
        value: "wholesale",
        label: "Retail Price List",
        defaultPriceListName: "Jensen Leisure Retail January 2026",
        importEndpoint: "/api/pricing/import/jensen-prices",
      },
    ],
  },
  {
    slug: "ekornes",
    nameMatch: "ekornes",
    displayName: "Ekornes (Stressless)",
    importTypes: [
      {
        value: "retail-prices",
        label: "MRP Price List (PDF)",
        defaultPriceListName: "Ekornes MRP January 2026",
        importEndpoint: "/api/pricing/import/ekornes-prices",
      },
    ],
  },
  {
    slug: "american-leather",
    nameMatch: "american leather",
    displayName: "American Leather",
    importTypes: [
      {
        value: "retail-prices",
        label: "Retail MRP Price List (PDF)",
        defaultPriceListName: "American Leather Retail November 2025",
        importEndpoint: "/api/pricing/import/american-leather",
      },
    ],
  },
];

// Use shared fabric parser from wesleyHallParser
const parseFabricRows = parseFabricRowsShared;

const STRUCTURED_VENDOR_SLUGS = new Set([
  "kingsley-bate",
  "brown-jordan",
  "summer-classics",
  "jensen-leisure",
  "ekornes",
  "american-leather",
]);

const TAB_ORDER: ImportStep[] = ["upload", "preview", "import"];

// XLSX vendor spreadsheets sometimes have a title row before the real headers.
const KNOWN_XLSX_COLS = new Set([
  "pattern",
  "grade",
  "color",
  "style",
  "description",
  "name",
  "fabric pattern",
  "fabric name",
  "fabric grade",
  "fabric color",
  "style no.",
  "swatch #",
]);

// ─── Pure helpers ──────────────────────────────────────────────────

function len(arr: unknown[] | undefined): number {
  return arr?.length ?? 0;
}

/** Human summary of parsed counts, by vendor shape. Pulled out of JSX to keep
 *  the render free of nested ternaries (Sonar S3358). */
function summarizeParsed(
  data: ParsedVendorData | null,
  productCount: number,
  importType: string,
): string {
  if (data?.seating) {
    return `${len(data.seating)} products, ${len(data.tables)} tables, ${len(data.fabrics)} fabrics, ${len(data.finishes)} finishes`;
  }
  if (data?.frames) {
    return `${len(data.frames)} frames, ${len(data.cushions)} cushions, ${len(data.covers)} covers, ${len(data.fabrics)} fabrics`;
  }
  if (data?.products && data?.collections) {
    return `${len(data.products)} products, ${len(data.collections)} collections`;
  }
  return `${productCount} ${importType === "fabrics" ? "fabrics" : "products"}`;
}

/** Label for the Import button's item count, by vendor shape. */
function importItemsLabel(
  data: ParsedVendorData | null,
  productCount: number,
  importType: string,
): string {
  if (data?.seating) return `${len(data.seating) + len(data.tables)} Items`;
  if (data?.frames) {
    return `${len(data.frames) + len(data.cushions) + len(data.covers)} Items`;
  }
  if (data?.products && data?.collections) return `${len(data.products)} Products`;
  return `${productCount} ${importType === "fabrics" ? "Fabrics" : "Products"}`;
}

function selectRowParser(importType: string) {
  if (importType === "fabrics") return parseFabricRows;
  if (importType === "foundations" || importType === "simplicity") return parseFoundationsRows;
  return parseWholesaleRows;
}

function diagnosticToast(label: string, diagnostics: ParseDiagnostic[]) {
  if (diagnostics.length > 0) {
    toast.warning(`${label} (${diagnostics.length} warnings)`);
  } else {
    toast.success(label);
  }
}

// ─── Sub-components ─────────────────────────────────────────────────

function VendorMissingNotice({ displayName }: Readonly<{ displayName?: string }>) {
  return (
    <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6 flex items-start gap-3">
      <AlertTriangle className="w-6 h-6 text-yellow-600 flex-shrink-0 mt-0.5" />
      <div>
        <p className="font-semibold text-yellow-800">{displayName} vendor not found</p>
        <p className="text-sm text-yellow-700 mt-1">
          Please create a vendor named &ldquo;{displayName}&rdquo; in the{" "}
          <Link href="/app/admin/setup" className="underline underline-offset-2 text-sh-blue">
            Admin Setup
          </Link>{" "}
          before importing price books.
        </p>
      </div>
    </div>
  );
}

function PriceListMetadata({
  vendorName,
  importType,
  priceListName,
  effectiveDate,
  onPriceListNameChange,
  onEffectiveDateChange,
}: Readonly<{
  vendorName: string;
  importType: string;
  priceListName: string;
  effectiveDate: string;
  onPriceListNameChange: (value: string) => void;
  onEffectiveDateChange: (value: string) => void;
}>) {
  const isFabrics = importType === "fabrics";
  return (
    <div
      className={`grid grid-cols-1 ${isFabrics ? "md:grid-cols-1 max-w-xs" : "md:grid-cols-3"} gap-4`}
    >
      <div>
        <span className="block text-sm font-semibold text-sh-blue mb-1">Vendor</span>
        <div className="w-full border border-sh-gray/20 bg-sh-linen rounded-lg px-3 py-2 text-sh-black font-serif">
          {vendorName || "Loading..."}
        </div>
      </div>
      {!isFabrics && (
        <>
          <div>
            <label
              htmlFor="price-list-name"
              className="block text-sm font-semibold text-sh-blue mb-1"
            >
              Price List Name
            </label>
            <input
              id="price-list-name"
              type="text"
              value={priceListName}
              onChange={(e) => onPriceListNameChange(e.target.value)}
              className="w-full border border-sh-gray rounded-lg px-3 py-2 text-sh-black font-serif"
            />
          </div>
          <div>
            <label
              htmlFor="effective-date"
              className="block text-sm font-semibold text-sh-blue mb-1"
            >
              Effective Date
            </label>
            <input
              id="effective-date"
              type="date"
              value={effectiveDate}
              onChange={(e) => onEffectiveDateChange(e.target.value)}
              className="w-full border border-sh-gray rounded-lg px-3 py-2 text-sh-black font-serif"
            />
          </div>
        </>
      )}
    </div>
  );
}

function UploadPanel({
  isDragging,
  onDragOver,
  onDragLeave,
  onDrop,
  onChoose,
}: Readonly<{
  isDragging: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onChoose: () => void;
}>) {
  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={`border-2 border-dashed rounded-lg p-10 text-center bg-white transition-colors ${
        isDragging ? "border-sh-blue bg-sh-blue/5" : "border-sh-gray/40"
      }`}
    >
      <Upload
        className={`w-12 h-12 mx-auto mb-4 transition-colors ${
          isDragging ? "text-sh-blue" : "text-sh-gray"
        }`}
      />
      <p className="text-sh-black font-semibold mb-2">
        {isDragging ? "Drop file to upload" : "Drop a file here or click to browse"}
      </p>
      <p className="text-sh-gray text-sm mb-6">Supports PDF, CSV, and XLSX files</p>
      <Button variant="primary" onClick={onChoose}>
        <FileText className="w-4 h-4 mr-2" /> Choose File
      </Button>
    </div>
  );
}

function ParseDiagnosticsList({ diagnostics }: Readonly<{ diagnostics: ParseDiagnostic[] }>) {
  const errorCount = diagnostics.filter((d) => d.level === "error").length;
  const warningCount = diagnostics.filter((d) => d.level === "warning").length;
  return (
    <details className="mt-4 border border-amber-300 rounded-lg bg-amber-50">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-amber-800">
        {errorCount > 0 && <span className="mr-2">{errorCount} errors</span>}
        {warningCount > 0 && <span>{warningCount} warnings</span>}
        {" -- click to expand"}
      </summary>
      <ul className="px-4 pb-3 text-xs text-amber-900 max-h-60 overflow-y-auto space-y-1">
        {diagnostics.slice(0, 200).map((d, i) => (
          <li key={i} className="flex gap-2">
            <span
              className={`font-semibold ${d.level === "error" ? "text-red-700" : "text-amber-700"}`}
            >
              {d.level === "error" ? "ERR" : "WARN"}
            </span>
            {d.row && <span className="text-amber-600">Row {d.row}</span>}
            <span>{d.message}</span>
          </li>
        ))}
        {diagnostics.length > 200 && (
          <li className="text-amber-600 italic">...and {diagnostics.length - 200} more</li>
        )}
      </ul>
    </details>
  );
}

function PreviewPanel({
  fileName,
  parsedProducts,
  parsedVendorData,
  importType,
  diagnostics,
  onReset,
}: Readonly<{
  fileName: string;
  parsedProducts: ParsedProduct[];
  parsedVendorData: ParsedVendorData | null;
  importType: string;
  diagnostics: ParseDiagnostic[];
  onReset: () => void;
}>) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <FileText className="w-5 h-5 text-sh-blue" />
          <span className="text-sm text-sh-black">
            <strong>{fileName}</strong> —{" "}
            {summarizeParsed(parsedVendorData, parsedProducts.length, importType)} parsed
          </span>
        </div>
        <Button variant="secondary" onClick={onReset}>
          Start Over
        </Button>
      </div>
      <ImportPreview
        products={parsedProducts}
        importType={importType}
        kbData={parsedVendorData as React.ComponentProps<typeof ImportPreview>["kbData"]}
      />
      {diagnostics.length > 0 && <ParseDiagnosticsList diagnostics={diagnostics} />}
    </div>
  );
}

function ImageExtractionBlock({
  result,
  extracting,
  onExtract,
  onClear,
}: Readonly<{
  result: ImageExtractionResult | null;
  extracting: boolean;
  onExtract: () => void;
  onClear: () => void;
}>) {
  if (result && !result.error) {
    return (
      <div className="border border-sh-gray/20 rounded-lg p-4 mt-2">
        <div className="text-sm text-green-700 space-y-1">
          <div className="flex items-center gap-2">
            <CheckCircle className="w-4 h-4 flex-shrink-0" />
            Extracted {result.imagesExtracted} images, mapped {result.stylesMapped} styles, updated{" "}
            {result.stylesUpdated} records
          </div>
          <div className="text-xs text-sh-gray ml-6">
            Page base: {result.pageNumberBase} | {result.pagesMatched}/{result.pagesWithImages}{" "}
            pages matched
          </div>
        </div>
      </div>
    );
  }

  if (result?.error) {
    return (
      <div className="border border-sh-gray/20 rounded-lg p-4 mt-2">
        <div className="space-y-2">
          <div className="text-sm text-red-600 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" />
            {result.error}
          </div>
          {result.details && <div className="text-xs text-sh-gray pl-6">{result.details}</div>}
          <Button variant="secondary" size="sm" onClick={onClear} className="ml-6">
            Try Again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="border border-sh-gray/20 rounded-lg p-4 mt-2">
      <div className="flex items-center justify-between">
        <div className="text-sm text-sh-gray">Extract line drawing images from the PDF?</div>
        <Button variant="secondary" onClick={onExtract} disabled={extracting}>
          {extracting ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Extracting...
            </>
          ) : (
            "Extract Images"
          )}
        </Button>
      </div>
    </div>
  );
}

function ImportSuccessPanel({
  result,
  showImageExtraction,
  imageExtractionResult,
  extractingImages,
  onExtractImages,
  onClearImageResult,
  onReset,
}: Readonly<{
  result: ImportResult;
  showImageExtraction: boolean;
  imageExtractionResult: ImageExtractionResult | null;
  extractingImages: boolean;
  onExtractImages: () => void;
  onClearImageResult: () => void;
  onReset: () => void;
}>) {
  const imported = result.importedCount ?? result.created ?? 0;
  const skipped = result.skippedCount ?? result.skipped ?? 0;
  const errorCount = result.errors?.length ?? 0;
  return (
    <div className="bg-white rounded-lg border border-green-200 shadow-md p-6 text-center space-y-4">
      <CheckCircle className="w-16 h-16 text-green-500 mx-auto" />
      <h2 className="text-xl font-semibold text-sh-blue">Import Complete</h2>
      <div className="grid grid-cols-3 gap-4 max-w-md mx-auto">
        <div className="bg-sh-linen rounded-lg p-3">
          <div className="text-2xl font-semibold text-sh-blue">{imported}</div>
          <div className="text-xs text-sh-gray">Imported</div>
        </div>
        <div className="bg-sh-linen rounded-lg p-3">
          <div className="text-2xl font-semibold text-sh-gray">{skipped}</div>
          <div className="text-xs text-sh-gray">Skipped</div>
        </div>
        <div className="bg-sh-linen rounded-lg p-3">
          <div className="text-2xl font-semibold text-sh-gray">{errorCount}</div>
          <div className="text-xs text-sh-gray">Errors</div>
        </div>
      </div>
      {errorCount > 0 && (
        <div className="text-left bg-yellow-50 rounded-lg p-4 mt-4">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="w-4 h-4 text-yellow-600" />
            <span className="text-sm font-semibold text-yellow-700">Warnings</span>
          </div>
          <ul className="text-xs text-yellow-700 space-y-1">
            {result.errors?.slice(0, 10).map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      {showImageExtraction && (
        <ImageExtractionBlock
          result={imageExtractionResult}
          extracting={extractingImages}
          onExtract={onExtractImages}
          onClear={onClearImageResult}
        />
      )}
      <div className="flex gap-3 justify-center pt-2">
        <Button variant="secondary" onClick={onReset}>
          Import Another
        </Button>
        <Button
          variant="primary"
          onClick={() => (globalThis.location.href = "/app/admin/pricing/configurator")}
        >
          Open Configurator
        </Button>
      </div>
    </div>
  );
}

function ImportingIndicator({
  productCount,
  importType,
  elapsed,
}: Readonly<{ productCount: number; importType: string; elapsed: number }>) {
  return (
    <div className="text-center py-16">
      <Loader2 className="w-12 h-12 text-sh-blue mx-auto mb-4 animate-spin" />
      <p className="text-sh-black font-semibold">
        Importing {productCount} {importType === "fabrics" ? "fabrics" : "products"}...
      </p>
      <p className="text-sh-gray text-sm mt-2">
        {importType === "fabrics"
          ? "Mapping fabrics to grade tiers and updating catalog."
          : "Creating price dimensions, grade tiers, and product prices."}
      </p>
      <p className="text-sh-gray text-xs mt-3">
        {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")} elapsed
      </p>
      {elapsed >= 60 && (
        <p className="text-sh-gray text-xs mt-1">Large imports may take several minutes.</p>
      )}
    </div>
  );
}

// ─── Main view ─────────────────────────────────────────────────────

export function PricingImportView() {
  const searchParams = useSearchParams();
  const urlVendor = searchParams?.get("vendor") ?? null;

  // ─── Vendor selection state ─────────────────────────────────────
  const [allVendors, setAllVendors] = useState<VendorOption[]>([]);
  const [selectedVendorSlug, setSelectedVendorSlug] = useState<string>("");
  const [vendorId, setVendorId] = useState<number | null>(null);
  const [vendorName, setVendorName] = useState("");
  const [vendorLoading, setVendorLoading] = useState(true);

  // ─── Import state ──────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<ImportStep>("upload");
  const [importTypeValue, setImportTypeValue] = useState("");
  const [parsedProducts, setParsedProducts] = useState<ParsedProduct[]>([]);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [fileName, setFileName] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [priceListName, setPriceListName] = useState("");
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  // Structured data for grouped vendors (KB, BJ, SC, JL, Ekornes, AL). Stored
  // separately because the import endpoint expects the grouped shape.
  const [parsedVendorData, setParsedVendorData] = useState<ParsedVendorData | null>(null);
  const [parseDiagnostics, setParseDiagnostics] = useState<ParseDiagnostic[]>([]);
  const [extractingImages, setExtractingImages] = useState(false);
  const [imageExtractionResult, setImageExtractionResult] = useState<ImageExtractionResult | null>(
    null,
  );
  const [effectiveDate, setEffectiveDate] = useState(new Date().toISOString().split("T")[0]);
  const [importElapsed, setImportElapsed] = useState(0);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Derived vendor config
  const vendorConfig = useMemo(
    () => VENDOR_CONFIGS.find((vc) => vc.slug === selectedVendorSlug) || null,
    [selectedVendorSlug],
  );

  const importTypeConfig = useMemo(
    () => vendorConfig?.importTypes.find((t) => t.value === importTypeValue) || null,
    [vendorConfig, importTypeValue],
  );

  const handleReset = useCallback(() => {
    setActiveTab("upload");
    setParsedProducts([]);
    setParsedVendorData(null);
    setParseDiagnostics([]);
    setImportResult(null);
    setFileName("");
    setImporting(false);
    setUploadedFile(null);
    setExtractingImages(false);
    setImageExtractionResult(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  // ─── Elapsed time counter during import ──────────────────────
  useEffect(() => {
    if (!importing) {
      setImportElapsed(0);
      return;
    }
    const interval = setInterval(() => setImportElapsed((s) => s + 1), 1000);
    return () => clearInterval(interval);
  }, [importing]);

  // ─── Load vendors on mount ────────────────────────────────────
  const loadVendors = useCallback(async () => {
    setVendorLoading(true);
    try {
      const res = await axios.get("/api/vendors?all=true");
      const raw = (res.data.vendors || res.data || []) as Array<{ id: number; name: string }>;
      const list: VendorOption[] = raw.map((v) => ({ id: v.id, name: v.name }));
      setAllVendors(list);

      // Auto-select from URL param (e.g. ?vendor=wesley-hall)
      if (urlVendor) {
        const config = VENDOR_CONFIGS.find((vc) => vc.slug === urlVendor);
        if (config) {
          const match = list.find((v) => v.name.toLowerCase().includes(config.nameMatch));
          if (match) {
            setSelectedVendorSlug(config.slug);
            setVendorId(match.id);
            setVendorName(match.name);
            setImportTypeValue(config.importTypes[0].value);
            setPriceListName(config.importTypes[0].defaultPriceListName);
          }
        }
      }
    } catch {
      // Vendor list is best-effort; the not-found notice covers an empty list.
    } finally {
      setVendorLoading(false);
    }
  }, [urlVendor]);

  useEffect(() => {
    loadVendors();
  }, [loadVendors]);

  // ─── Vendor change handler ────────────────────────────────────
  const handleVendorChange = useCallback(
    (slug: string) => {
      setSelectedVendorSlug(slug);
      handleReset();

      const config = VENDOR_CONFIGS.find((vc) => vc.slug === slug);
      if (!config) {
        setVendorId(null);
        setVendorName("");
        setImportTypeValue("");
        setPriceListName("");
        return;
      }

      const match = allVendors.find((v) => v.name.toLowerCase().includes(config.nameMatch));
      if (match) {
        setVendorId(match.id);
        setVendorName(match.name);
      } else {
        setVendorId(null);
        setVendorName("");
      }

      setImportTypeValue(config.importTypes[0].value);
      setPriceListName(config.importTypes[0].defaultPriceListName);
    },
    [allVendors, handleReset],
  );

  // ─── Import type change handler ───────────────────────────────
  const handleImportTypeChange = useCallback(
    (value: string) => {
      setImportTypeValue(value);
      handleReset();

      const typeConfig = vendorConfig?.importTypes.find((t) => t.value === value);
      if (typeConfig) {
        setPriceListName(typeConfig.defaultPriceListName);
      }
    },
    [vendorConfig, handleReset],
  );

  // ─── PDF parse handling ───────────────────────────────────────
  const applyPdfResult = useCallback(
    (
      data: ParsedVendorData & { frames?: unknown[]; seating?: unknown[]; products?: unknown[] },
    ) => {
      // Grouped vendors return structured data; flatten the primary type into
      // parsedProducts for preview/count and keep the full shape for import.
      if (vendorConfig?.slug === "kingsley-bate" && data.frames) {
        setParsedVendorData(data);
        setParsedProducts(data.frames as ParsedProduct[]);
      } else if (vendorConfig?.slug === "brown-jordan" && data.seating) {
        setParsedVendorData(data);
        setParsedProducts(data.seating as ParsedProduct[]);
      } else if (vendorConfig && STRUCTURED_VENDOR_SLUGS.has(vendorConfig.slug) && data.products) {
        setParsedVendorData(data);
        setParsedProducts(data.products as ParsedProduct[]);
      } else {
        setParsedProducts(data as unknown as ParsedProduct[]);
      }
    },
    [vendorConfig],
  );

  const parsePdf = useCallback(
    async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("type", importTypeValue);
      if (vendorConfig) formData.append("vendor", vendorConfig.slug);

      toast.info("Parsing PDF... this may take a moment.");
      const res = await axios.post("/api/pricing/parse-pdf", formData, {
        headers: { "Content-Type": "multipart/form-data" },
        timeout: 120000,
      });

      if (!res.data.success) {
        toast.error("Failed to parse PDF");
        return;
      }

      const diagnostics = (res.data.diagnostics || []) as ParseDiagnostic[];
      setParseDiagnostics(diagnostics);
      applyPdfResult(res.data.data);
      setActiveTab("preview");
      diagnosticToast(`Parsed ${res.data.count} items from PDF`, diagnostics);
    },
    [importTypeValue, vendorConfig, applyPdfResult],
  );

  const parseSpreadsheetRows = useCallback(
    (rows: Record<string, unknown>[], source: string) => {
      const parseRows = selectRowParser(importTypeValue);
      const parseResult = parseRows(rows);
      setParsedProducts(parseResult.data as ParsedProduct[]);
      setParseDiagnostics(parseResult.diagnostics);
      setActiveTab("preview");
      diagnosticToast(
        `Parsed ${parseResult.data.length} products from ${source}`,
        parseResult.diagnostics,
      );
    },
    [importTypeValue],
  );

  const parseCsv = useCallback(
    (file: File) => {
      Papa.parse<Record<string, unknown>>(file, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => parseSpreadsheetRows(results.data, "CSV"),
        error: (err) => toast.error(`CSV parse error: ${err.message}`),
      });
    },
    [parseSpreadsheetRows],
  );

  const parseXlsx = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = (evt) => {
        const data = evt.target?.result;
        const workbook = XLSX.read(data, { type: "binary" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        let rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);
        // Some vendor spreadsheets have a title row before the actual headers.
        // If the parsed column names don't match known data columns, re-parse
        // starting one row down.
        if (rows.length > 0) {
          const keys = Object.keys(rows[0]);
          const hasDataCols = keys.some((k) => KNOWN_XLSX_COLS.has(k.toLowerCase().trim()));
          if (!hasDataCols) {
            rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { range: 1 });
          }
        }
        parseSpreadsheetRows(rows, "XLSX");
      };
      reader.readAsBinaryString(file);
    },
    [parseSpreadsheetRows],
  );

  const processFile = useCallback(
    async (file: File) => {
      setFileName(file.name);
      setUploadedFile(file); // Keep reference for image extraction later
      const ext = file.name.split(".").pop()?.toLowerCase();

      try {
        if (ext === "pdf") {
          await parsePdf(file);
        } else if (ext === "csv") {
          parseCsv(file);
        } else if (ext === "xlsx" || ext === "xls") {
          parseXlsx(file);
        } else {
          toast.error("Unsupported file type. Please upload a PDF, CSV, or XLSX file.");
        }
      } catch (err: unknown) {
        toast.error(getErrorMessage(err, "Failed to process file."));
      }
    },
    [parsePdf, parseCsv, parseXlsx],
  );

  // ─── File input + drag-and-drop handlers ──────────────────────
  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) processFile(file);
    },
    [processFile],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      const file = e.dataTransfer.files?.[0];
      if (file) processFile(file);
    },
    [processFile],
  );

  // ─── Import handler ──────────────────────────────────────────
  const handleImport = useCallback(async () => {
    if (!vendorId) {
      toast.error("Vendor not found in database");
      return;
    }
    if (parsedProducts.length === 0) {
      toast.error("No products to import");
      return;
    }

    setImporting(true);
    setActiveTab("import");

    try {
      const importUrl = importTypeConfig?.importEndpoint || "/api/pricing/import/wholesale-prices";

      // Different body shapes by import type
      const isFabricImport = importTypeValue === "fabrics";
      const isStructuredImport =
        !!vendorConfig && STRUCTURED_VENDOR_SLUGS.has(vendorConfig.slug) && !!parsedVendorData;

      let body: Record<string, unknown>;
      if (isFabricImport) {
        body = { vendorId, fabrics: parsedProducts, clearExisting: true };
      } else if (isStructuredImport) {
        body = { vendorId, priceListName, effectiveDate, products: parsedVendorData };
      } else {
        body = { vendorId, priceListName, effectiveDate, products: parsedProducts };
      }

      const res = await axios.post<ImportResult>(importUrl, body, {
        timeout: 300000,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });

      if (res.data.success) {
        setImportResult(res.data);
        const count = res.data.importedCount ?? res.data.created ?? 0;
        toast.success(`Imported ${count} ${isFabricImport ? "fabrics" : "products"}!`);
      } else {
        toast.error("Import failed");
        setActiveTab("preview");
      }
    } catch (err: unknown) {
      const isTimeout =
        axios.isAxiosError(err) &&
        (err.code === "ECONNABORTED" || !!err.message?.includes("timeout"));
      if (isTimeout) {
        toast.error(
          "Import timed out. The data may have been partially imported. Check the product list to verify.",
          { autoClose: false },
        );
      } else {
        toast.error(getErrorMessage(err, "Import failed."));
      }
      setActiveTab("preview");
    } finally {
      setImporting(false);
    }
  }, [
    vendorId,
    parsedProducts,
    importTypeConfig,
    importTypeValue,
    vendorConfig,
    parsedVendorData,
    priceListName,
    effectiveDate,
  ]);

  // ─── Image extraction handler ──────────────────────────────────
  const handleExtractImages = useCallback(async () => {
    if (!uploadedFile || !vendorId) return;
    setExtractingImages(true);
    setImageExtractionResult(null);
    try {
      const formData = new FormData();
      formData.append("file", uploadedFile);
      formData.append("vendorId", String(vendorId));
      const res = await axios.post<ImageExtractionResult>("/api/pricing/extract-images", formData, {
        timeout: 300_000, // 5 min timeout for large PDFs
      });
      setImageExtractionResult(res.data);
      toast.success(
        `Extracted ${res.data.imagesExtracted} images, mapped ${res.data.stylesMapped} styles, ` +
          `updated ${res.data.stylesUpdated} records (page base: ${res.data.pageNumberBase}, ` +
          `${res.data.pagesMatched} pages matched)`,
      );
    } catch (err: unknown) {
      const errorMsg = getErrorMessage(err, "Image extraction failed");
      const details = axios.isAxiosError(err)
        ? ((err.response?.data as { details?: string })?.details ?? err.message)
        : undefined;
      toast.error(details ? `${errorMsg}: ${details}` : errorMsg);
      setImageExtractionResult({ error: errorMsg, details });
    } finally {
      setExtractingImages(false);
    }
  }, [uploadedFile, vendorId]);

  // ─── Tab definitions ──────────────────────────────────────────
  const tabs = useMemo<StepTabDefinition[]>(() => {
    const importedCount = importResult?.importedCount ?? importResult?.created ?? 0;
    let importSubtitle: string | null = null;
    if (importResult) importSubtitle = `${importedCount} imported`;
    else if (importing) importSubtitle = "Importing...";

    return [
      {
        id: "upload",
        label: "Upload",
        subtitle: fileName || null,
        completed: parsedProducts.length > 0,
      },
      {
        id: "preview",
        label: "Preview",
        subtitle:
          parsedProducts.length > 0
            ? `${summarizeParsed(parsedVendorData, parsedProducts.length, importTypeValue)} parsed`
            : null,
        disabled: parsedProducts.length === 0,
        completed: !!importResult,
      },
      {
        id: "import",
        label: "Import",
        subtitle: importSubtitle,
        disabled: parsedProducts.length === 0,
        completed: !!importResult,
      },
    ];
  }, [fileName, parsedProducts.length, parsedVendorData, importTypeValue, importing, importResult]);

  // ─── Bottom bar navigation ────────────────────────────────────
  const goBack = useCallback(() => {
    const idx = TAB_ORDER.indexOf(activeTab);
    if (idx > 0) setActiveTab(TAB_ORDER[idx - 1]);
  }, [activeTab]);

  const goNext = useCallback(() => {
    if (activeTab === "preview") {
      handleImport();
      return;
    }
    const idx = TAB_ORDER.indexOf(activeTab);
    if (idx < TAB_ORDER.length - 1) {
      const nextTab = TAB_ORDER[idx + 1];
      const nextDef = tabs.find((t) => t.id === nextTab);
      if (!nextDef?.disabled) setActiveTab(nextTab);
    }
  }, [activeTab, handleImport, tabs]);

  const bottomBar = (
    <div className="flex items-center justify-between">
      {activeTab !== "upload" ? (
        <Button variant="outline" onClick={goBack} className="min-w-[100px] gap-1">
          <ChevronLeft className="w-4 h-4" /> Back
        </Button>
      ) : (
        <div className="min-w-[100px]" />
      )}

      {activeTab !== "import" ? (
        <Button
          variant="primary"
          onClick={goNext}
          disabled={activeTab === "upload" && parsedProducts.length === 0}
          className="min-w-[140px] gap-1"
        >
          {activeTab === "preview" ? (
            <>Import {importItemsLabel(parsedVendorData, parsedProducts.length, importTypeValue)}</>
          ) : (
            <>
              Next <ChevronRight className="w-4 h-4" />
            </>
          )}
        </Button>
      ) : (
        <div className="min-w-[140px]" />
      )}
    </div>
  );

  const vendorMissing = !!selectedVendorSlug && !vendorLoading && !vendorId;

  return (
    <div className="py-2 font-serif space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-sh-blue mb-1">Import Price Book</h1>
        <p className="text-sh-gray text-sm">
          Upload a vendor price list PDF, CSV, or XLSX to import pricing data.
        </p>
      </div>

      {/* Vendor Selector */}
      <div className="max-w-xs">
        <FormDropdown
          label="Vendor"
          options={VENDOR_CONFIGS.map((vc) => ({ id: vc.slug, name: vc.displayName }))}
          value={selectedVendorSlug}
          onChange={handleVendorChange}
        />
      </div>

      {vendorMissing && <VendorMissingNotice displayName={vendorConfig?.displayName} />}

      {!selectedVendorSlug && !vendorLoading && (
        <div className="text-center py-16 text-sh-gray">
          Select a vendor to begin importing a price book.
        </div>
      )}

      {vendorConfig && vendorId && (
        <>
          {vendorConfig.importTypes.length > 1 && (
            <div className="flex gap-3">
              {vendorConfig.importTypes.map((it) => (
                <button
                  key={it.value}
                  type="button"
                  onClick={() => handleImportTypeChange(it.value)}
                  className={`px-4 py-2 rounded-lg text-sm font-semibold transition ${
                    importTypeValue === it.value
                      ? "bg-sh-blue text-white shadow-md"
                      : "bg-white text-sh-gray border border-sh-gray/30 hover:border-sh-blue hover:text-sh-blue"
                  }`}
                >
                  {it.label}
                </button>
              ))}
            </div>
          )}

          <PriceListMetadata
            vendorName={vendorName}
            importType={importTypeValue}
            priceListName={priceListName}
            effectiveDate={effectiveDate}
            onPriceListNameChange={setPriceListName}
            onEffectiveDateChange={setEffectiveDate}
          />

          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            id="price-book-file"
            type="file"
            accept=".pdf,.csv,.xlsx,.xls"
            onChange={handleFileInput}
            className="hidden"
          />

          {/* Tabbed import wizard */}
          <div className="flex flex-col min-h-0" style={{ height: "calc(100vh - 460px)" }}>
            <StepTabs
              tabs={tabs}
              activeTab={activeTab}
              onTabChange={(id) => setActiveTab(id as ImportStep)}
              bottomBar={bottomBar}
            >
              <StepTabPanel tabId="upload">
                <UploadPanel
                  isDragging={isDragging}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  onChoose={() => fileInputRef.current?.click()}
                />
              </StepTabPanel>

              <StepTabPanel tabId="preview">
                <PreviewPanel
                  fileName={fileName}
                  parsedProducts={parsedProducts}
                  parsedVendorData={parsedVendorData}
                  importType={importTypeValue}
                  diagnostics={parseDiagnostics}
                  onReset={handleReset}
                />
              </StepTabPanel>

              <StepTabPanel tabId="import">
                {importing && !importResult && (
                  <ImportingIndicator
                    productCount={parsedProducts.length}
                    importType={importTypeValue}
                    elapsed={importElapsed}
                  />
                )}

                {importResult && (
                  <ImportSuccessPanel
                    result={importResult}
                    showImageExtraction={!!uploadedFile}
                    imageExtractionResult={imageExtractionResult}
                    extractingImages={extractingImages}
                    onExtractImages={handleExtractImages}
                    onClearImageResult={() => setImageExtractionResult(null)}
                    onReset={handleReset}
                  />
                )}

                {!importing && !importResult && (
                  <div className="text-center py-16">
                    <p className="text-sh-gray">
                      Click &ldquo;Import&rdquo; from the Preview tab to begin importing.
                    </p>
                  </div>
                )}
              </StepTabPanel>
            </StepTabs>
          </div>
        </>
      )}
    </div>
  );
}
