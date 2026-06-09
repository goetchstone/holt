"use client";

// /app/src/app/(dashboard)/app/admin/pricing/fabrics/FabricsView.tsx
//
// Fabric Catalog body. App Router port of the legacy admin/pricing/fabrics body
// (minus MainLayout chrome, which the (dashboard) layout supplies). Pick a
// vendor, search/filter its fabrics by grade tier, and import a CSV/XLSX catalog
// that maps each fabric to a grade tier. Fabrics + dimensions load from the
// shared /api/pricing/* REST endpoints, which stay REST.

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";
import { toast } from "react-toastify";
import axios from "axios";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import {
  Search,
  Upload,
  FileText,
  Loader2,
  CheckCircle,
  AlertTriangle,
  Palette,
  Filter,
  X,
  ChevronDown,
} from "lucide-react";

// ─── Types ─────────────────────────────────────────────────────────

type FabricRecord = Record<string, string | number | null | undefined>;

interface FabricRow {
  id: number;
  fabricName: string;
  fabricCode: string | null;
  colorName: string;
  colorCode: string | null;
  patternRepeat: string | null;
  width: string | null;
  content: string | null;
  collection: string | null;
  usage: string | null;
  notes: string | null;
  isActive: boolean;
  isDiscontinued: boolean;
  tier: {
    id: number;
    code: string;
    name: string;
    sortOrder: number;
  };
}

interface VendorOption {
  id: number;
  name: string;
}

interface GradeTier {
  id: number;
  code: string;
  name: string;
}

interface GradeBreakdownEntry {
  tierId: number;
  _count: number;
}

interface ImportResult {
  success: boolean;
  created: number;
  skipped: number;
  totalErrors: number;
  unmatchedGrades?: string[];
  availableGrades?: string[];
  errors?: string[];
}

interface DimensionTier {
  id: number;
  code: string;
  name: string;
}

interface PricingDimension {
  tiers?: DimensionTier[];
}

// ─── Column mapping ─────────────────────────────────────────────────
// Maps common column header names from vendor CSVs to our internal field names.
// Case-insensitive matching applied at import time.

const COLUMN_MAP: Record<string, string> = {
  // Fabric name
  "fabric name": "fabricName",
  fabricname: "fabricName",
  fabric: "fabricName",
  pattern: "fabricName",
  "pattern name": "fabricName",
  name: "fabricName",
  // Fabric code
  "fabric code": "fabricCode",
  fabriccode: "fabricCode",
  code: "fabricCode",
  sku: "fabricCode",
  item: "fabricCode",
  "item #": "fabricCode",
  "item number": "fabricCode",
  // Grade
  grade: "grade",
  "grade level": "grade",
  "fabric grade": "grade",
  tier: "grade",
  "price grade": "grade",
  // Color
  color: "colorName",
  "color name": "colorName",
  colorname: "colorName",
  colorway: "colorName",
  // Color code
  "color code": "colorCode",
  colorcode: "colorCode",
  "color #": "colorCode",
  "color number": "colorCode",
  // Pattern repeat
  "pattern repeat": "patternRepeat",
  repeat: "patternRepeat",
  // Width
  width: "width",
  "fabric width": "width",
  // Content / fiber
  content: "content",
  "fiber content": "content",
  fiber: "content",
  composition: "content",
  // Collection
  collection: "collection",
  line: "collection",
  book: "collection",
  // Usage
  usage: "usage",
  use: "usage",
  application: "usage",
  // Notes
  notes: "notes",
  note: "notes",
  comments: "notes",
};

function mapColumns(rows: FabricRecord[]): FabricRecord[] {
  if (rows.length === 0) return [];
  // Build a mapping from original header → internal field name
  const headers = Object.keys(rows[0]);
  const mapping: Record<string, string> = {};
  for (const h of headers) {
    const key = h.trim().toLowerCase();
    if (COLUMN_MAP[key]) {
      mapping[h] = COLUMN_MAP[key];
    }
  }

  return rows.map((row) => {
    const mapped: FabricRecord = {};
    for (const [origKey, value] of Object.entries(row)) {
      const internalKey = mapping[origKey] || origKey;
      mapped[internalKey] = value;
    }
    return mapped;
  });
}

// ─── Import sub-components ──────────────────────────────────────────

function ImportDropZone({
  isDragging,
  fileInputRef,
  onFileInput,
  onDragOver,
  onDragLeave,
  onDrop,
}: Readonly<{
  isDragging: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFileInput: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}>) {
  return (
    <>
      <input
        ref={fileInputRef}
        id="fabric-import-file"
        type="file"
        accept=".csv,.xlsx,.xls"
        onChange={onFileInput}
        className="hidden"
      />
      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
          isDragging ? "border-sh-blue bg-sh-blue/5" : "border-sh-gray/40"
        }`}
      >
        <Upload
          className={`w-10 h-10 mx-auto mb-3 ${isDragging ? "text-sh-blue" : "text-sh-gray"}`}
        />
        <p className="text-sh-black font-semibold mb-2">
          {isDragging ? "Drop file" : "Drop a CSV/XLSX file or click to browse"}
        </p>
        <Button variant="secondary" onClick={() => fileInputRef.current?.click()}>
          <FileText className="w-4 h-4 mr-2" /> Choose File
        </Button>
      </div>
    </>
  );
}

function ColumnChip({ col }: Readonly<{ col: string }>) {
  const isRequired = col === "fabricName" || col === "grade";
  const className = isRequired ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-600";
  return <span className={`px-2 py-0.5 rounded text-xs font-medium ${className}`}>{col}</span>;
}

function MissingColumnWarning({ field, hint }: Readonly<{ field: string; hint: string }>) {
  return (
    <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
      <AlertTriangle className="w-4 h-4 text-red-500" />
      <span className="text-sm text-red-700">
        Missing required column: <strong>{field}</strong> ({hint})
      </span>
    </div>
  );
}

function ImportPreviewTable({
  detectedColumns,
  rows,
}: Readonly<{ detectedColumns: string[]; rows: FabricRecord[] }>) {
  const visibleColumns = detectedColumns.slice(0, 8);
  return (
    <div className="overflow-x-auto border border-sh-gray/20 rounded-lg max-h-[300px] overflow-y-auto">
      <table className="min-w-full text-xs">
        <thead className="bg-sh-linen sticky top-0">
          <tr>
            <th className="px-3 py-2 text-left text-sh-gray font-semibold">#</th>
            {visibleColumns.map((col) => (
              <th key={col} className="px-3 py-2 text-left text-sh-gray font-semibold">
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-sh-gray/10">
          {rows.slice(0, 20).map((row, i) => (
            <tr key={i} className="hover:bg-sh-linen/50">
              <td className="px-3 py-1.5 text-sh-gray">{i + 1}</td>
              {visibleColumns.map((col) => (
                <td key={col} className="px-3 py-1.5 text-sh-black truncate max-w-[200px]">
                  {String(row[col] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 20 && (
        <div className="px-3 py-2 text-xs text-sh-gray bg-sh-linen text-center">
          Showing 20 of {rows.length} rows
        </div>
      )}
    </div>
  );
}

function ImportResultPanel({
  result,
  onReset,
}: Readonly<{ result: ImportResult; onReset: () => void }>) {
  return (
    <div className="bg-green-50 border border-green-200 rounded-lg p-6 text-center space-y-4">
      <CheckCircle className="w-12 h-12 text-green-500 mx-auto" />
      <h3 className="text-lg font-semibold text-sh-blue">Import Complete</h3>
      <div className="grid grid-cols-3 gap-4 max-w-sm mx-auto">
        <div className="bg-white rounded-lg p-3">
          <div className="text-xl font-semibold text-sh-blue">{result.created}</div>
          <div className="text-xs text-sh-gray">Created</div>
        </div>
        <div className="bg-white rounded-lg p-3">
          <div className="text-xl font-semibold text-sh-gray">{result.skipped}</div>
          <div className="text-xs text-sh-gray">Skipped</div>
        </div>
        <div className="bg-white rounded-lg p-3">
          <div className="text-xl font-semibold text-sh-gray">{result.totalErrors}</div>
          <div className="text-xs text-sh-gray">Errors</div>
        </div>
      </div>

      {result.unmatchedGrades && result.unmatchedGrades.length > 0 && (
        <div className="text-left bg-yellow-50 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="w-4 h-4 text-yellow-600" />
            <span className="text-sm font-semibold text-yellow-700">Unmatched Grades</span>
          </div>
          <p className="text-xs text-yellow-700 mb-2">
            These grade values did not match any existing tier:
          </p>
          <div className="flex flex-wrap gap-1">
            {result.unmatchedGrades.map((g) => (
              <span key={g} className="px-2 py-0.5 bg-yellow-100 text-yellow-800 rounded text-xs">
                {g}
              </span>
            ))}
          </div>
          {result.availableGrades && result.availableGrades.length > 0 && (
            <p className="text-xs text-yellow-600 mt-2">
              Available grades: {result.availableGrades.join(", ")}
            </p>
          )}
        </div>
      )}

      {result.errors && result.errors.length > 0 && (
        <div className="text-left bg-yellow-50 rounded-lg p-4">
          <ul className="text-xs text-yellow-700 space-y-1 max-h-[150px] overflow-y-auto">
            {result.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      <Button variant="secondary" onClick={onReset}>
        Import Another
      </Button>
    </div>
  );
}

interface ImportPanelProps {
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  importPreview: FabricRecord[];
  importFileName: string;
  importResult: ImportResult | null;
  importing: boolean;
  clearExisting: boolean;
  isDragging: boolean;
  detectedColumns: string[];
  hasFabricName: boolean;
  hasGrade: boolean;
  onClose: () => void;
  onFileInput: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onReset: () => void;
  onClearExistingChange: (value: boolean) => void;
  onImport: () => void;
}

function ImportPanel(props: Readonly<ImportPanelProps>) {
  const showDropZone = props.importPreview.length === 0 && !props.importResult;
  const showPreview = props.importPreview.length > 0 && !props.importResult;

  return (
    <div className="bg-white border border-sh-gray/20 rounded-lg shadow-sm p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-sh-blue">Import Fabric Catalog</h2>
        <button
          type="button"
          aria-label="Close import panel"
          onClick={props.onClose}
          className="text-sh-gray hover:text-sh-black transition"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <p className="text-sm text-sh-gray">
        Upload a CSV or XLSX with fabric data. Required columns: <strong>Fabric Name</strong> and{" "}
        <strong>Grade</strong>. Optional columns: Color, Code, Pattern Repeat, Width, Content,
        Collection, Usage, Notes.
      </p>

      {showDropZone && (
        <ImportDropZone
          isDragging={props.isDragging}
          fileInputRef={props.fileInputRef}
          onFileInput={props.onFileInput}
          onDragOver={props.onDragOver}
          onDragLeave={props.onDragLeave}
          onDrop={props.onDrop}
        />
      )}

      {showPreview && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FileText className="w-5 h-5 text-sh-blue" />
              <span className="text-sm">
                <strong>{props.importFileName}</strong> — {props.importPreview.length} rows
              </span>
            </div>
            <Button variant="secondary" onClick={props.onReset}>
              Start Over
            </Button>
          </div>

          <div className="flex flex-wrap gap-2">
            {props.detectedColumns.map((col) => (
              <ColumnChip key={col} col={col} />
            ))}
          </div>

          {!props.hasFabricName && (
            <MissingColumnWarning field="fabricName" hint='or "Fabric Name", "Pattern", "Name"' />
          )}
          {!props.hasGrade && (
            <MissingColumnWarning field="grade" hint='or "Fabric Grade", "Grade Level"' />
          )}

          <ImportPreviewTable detectedColumns={props.detectedColumns} rows={props.importPreview} />

          <div className="flex items-center justify-between">
            <label
              htmlFor="fabric-clear-existing"
              className="flex items-center gap-2 text-sm text-sh-gray cursor-pointer"
            >
              <input
                id="fabric-clear-existing"
                type="checkbox"
                checked={props.clearExisting}
                onChange={(e) => props.onClearExistingChange(e.target.checked)}
                className="w-4 h-4 accent-sh-blue"
              />
              Clear existing fabrics before import
            </label>
            <Button
              variant="primary"
              onClick={props.onImport}
              disabled={props.importing || !props.hasFabricName || !props.hasGrade}
            >
              {props.importing ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Importing...
                </>
              ) : (
                <>Import {props.importPreview.length} Fabrics</>
              )}
            </Button>
          </div>
        </div>
      )}

      {props.importResult && (
        <ImportResultPanel result={props.importResult} onReset={props.onReset} />
      )}
    </div>
  );
}

// ─── Filter + table sub-components ──────────────────────────────────

interface FilterBarProps {
  searchQuery: string;
  selectedGrade: string;
  gradeTiers: GradeTier[];
  gradeBreakdown: GradeBreakdownEntry[];
  total: number;
  onSearchChange: (value: string) => void;
  onGradeChange: (value: string) => void;
}

function FabricFilterBar(props: Readonly<FilterBarProps>) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="relative flex-1 min-w-[200px]">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-sh-gray" />
        <input
          id="fabric-search"
          type="text"
          aria-label="Search fabrics"
          value={props.searchQuery}
          onChange={(e) => props.onSearchChange(e.target.value)}
          placeholder="Search by fabric name, code, or color..."
          className="w-full border border-sh-gray rounded-lg pl-10 pr-3 py-2 text-sm text-sh-black"
        />
        {props.searchQuery && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => props.onSearchChange("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-sh-gray hover:text-sh-black"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      <div className="relative">
        <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-sh-gray pointer-events-none" />
        <select
          id="fabric-grade-filter"
          aria-label="Filter by grade"
          value={props.selectedGrade}
          onChange={(e) => props.onGradeChange(e.target.value)}
          className="border border-sh-gray rounded-lg pl-9 pr-8 py-2 text-sm bg-white text-sh-black appearance-none cursor-pointer"
        >
          <option value="">All Grades</option>
          {props.gradeTiers.map((tier) => {
            const count = props.gradeBreakdown.find((g) => g.tierId === tier.id)?._count;
            return (
              <option key={tier.id} value={tier.id}>
                {tier.name}
                {count ? ` (${count})` : ""}
              </option>
            );
          })}
        </select>
        <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-sh-gray pointer-events-none" />
      </div>

      <span className="text-sm text-sh-gray tabular-nums">
        {props.total} fabric{props.total !== 1 ? "s" : ""}
      </span>
    </div>
  );
}

function FabricTableRow({ fabric }: Readonly<{ fabric: FabricRow }>) {
  return (
    <tr className="hover:bg-sh-linen/50 transition">
      <td className="px-4 py-2.5 text-sh-black font-medium">
        {fabric.fabricName}
        {fabric.isDiscontinued && (
          <span className="ml-2 px-1.5 py-0.5 rounded bg-red-100 text-red-600 text-xs">
            Discontinued
          </span>
        )}
      </td>
      <td className="px-4 py-2.5 text-sh-gray tabular-nums">{fabric.fabricCode || "—"}</td>
      <td className="px-4 py-2.5 text-sh-black">{fabric.colorName || "—"}</td>
      <td className="px-4 py-2.5">
        <span className="px-2 py-0.5 rounded bg-sh-blue/10 text-sh-blue text-xs font-medium">
          {fabric.tier?.name || "—"}
        </span>
      </td>
      <td className="px-4 py-2.5 text-sh-gray text-xs max-w-[200px] truncate">
        {fabric.content || "—"}
      </td>
      <td className="px-4 py-2.5 text-sh-gray text-xs">{fabric.width || "—"}</td>
      <td className="px-4 py-2.5 text-sh-gray text-xs">{fabric.collection || "—"}</td>
    </tr>
  );
}

const FABRIC_COLUMNS = ["Fabric Name", "Code", "Color", "Grade", "Content", "Width", "Collection"];

function FabricTable({ fabrics }: Readonly<{ fabrics: FabricRow[] }>) {
  return (
    <div className="overflow-x-auto border border-sh-gray/20 rounded-lg shadow-sm">
      <table className="min-w-full text-sm">
        <thead className="bg-sh-linen">
          <tr>
            {FABRIC_COLUMNS.map((col) => (
              <th
                key={col}
                className="px-4 py-3 text-left text-sh-gray font-semibold text-xs uppercase tracking-wider"
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-sh-gray/10 bg-white">
          {fabrics.map((f) => (
            <FabricTableRow key={f.id} fabric={f} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FabricEmptyState({ filtered }: Readonly<{ filtered: boolean }>) {
  return (
    <div className="text-center py-16">
      <Palette className="w-12 h-12 mx-auto mb-4 text-sh-gray opacity-30" />
      <p className="text-sh-gray">
        {filtered ? "No fabrics match your search." : "No fabrics loaded for this vendor yet."}
      </p>
      {!filtered && (
        <p className="text-sm text-sh-gray mt-2">
          Click &ldquo;Import Fabrics&rdquo; to upload a CSV or XLSX.
        </p>
      )}
    </div>
  );
}

// ─── Main view ─────────────────────────────────────────────────────

export function FabricsView() {
  // ─── Vendor state ──────────────────────────────────────────────
  const [vendors, setVendors] = useState<VendorOption[]>([]);
  const [selectedVendorId, setSelectedVendorId] = useState<number | null>(null);
  const [vendorLoading, setVendorLoading] = useState(true);

  // ─── Fabric list state ─────────────────────────────────────────
  const [fabrics, setFabrics] = useState<FabricRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedGrade, setSelectedGrade] = useState("");
  const [gradeBreakdown, setGradeBreakdown] = useState<GradeBreakdownEntry[]>([]);
  const [gradeTiers, setGradeTiers] = useState<GradeTier[]>([]);

  // ─── Import state ──────────────────────────────────────────────
  const [showImport, setShowImport] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importPreview, setImportPreview] = useState<FabricRecord[]>([]);
  const [importFileName, setImportFileName] = useState("");
  const [clearExisting, setClearExisting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ─── Load vendors ──────────────────────────────────────────────
  const loadVendors = useCallback(async () => {
    setVendorLoading(true);
    try {
      const res = await axios.get("/api/vendors?all=true");
      const raw: VendorOption[] = res.data.vendors || res.data || [];
      const list: VendorOption[] = raw.map((v) => ({ id: v.id, name: v.name }));
      setVendors(list);

      // Auto-select first vendor with "wesley hall" in name, else first vendor
      const wh = list.find((v) => v.name.toLowerCase().includes("wesley hall"));
      if (wh) setSelectedVendorId(wh.id);
      else if (list.length > 0) setSelectedVendorId(list[0].id);
    } catch {
      // Vendor list is non-critical; the empty-state prompts selection.
    } finally {
      setVendorLoading(false);
    }
  }, []);

  useEffect(() => {
    loadVendors();
  }, [loadVendors]);

  // ─── Load grade tiers when vendor changes ──────────────────────
  const loadGradeTiers = useCallback(async () => {
    if (!selectedVendorId) {
      setGradeTiers([]);
      return;
    }
    try {
      const res = await axios.get(`/api/pricing/dimensions?vendorId=${selectedVendorId}`);
      const dims: PricingDimension[] = res.data || [];
      const tiers: GradeTier[] = [];
      for (const dim of dims) {
        for (const tier of dim.tiers || []) {
          tiers.push({ id: tier.id, code: tier.code, name: tier.name });
        }
      }
      setGradeTiers(tiers);
    } catch {
      setGradeTiers([]);
    }
  }, [selectedVendorId]);

  useEffect(() => {
    loadGradeTiers();
  }, [loadGradeTiers]);

  // ─── Load fabrics ──────────────────────────────────────────────
  const fetchFabrics = useCallback(async () => {
    if (!selectedVendorId) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({
        vendorId: String(selectedVendorId),
        all: "true",
      });
      if (searchQuery) params.set("search", searchQuery);
      if (selectedGrade) params.set("tierId", selectedGrade);

      const res = await axios.get(`/api/pricing/fabrics?${params}`);
      setFabrics(res.data.fabrics || []);
      setTotal(res.data.total || 0);
      setGradeBreakdown(res.data.gradeBreakdown || []);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to load fabrics"));
    } finally {
      setLoading(false);
    }
  }, [selectedVendorId, searchQuery, selectedGrade]);

  useEffect(() => {
    fetchFabrics();
  }, [fetchFabrics]);

  // ─── File processing for import ────────────────────────────────
  const processFile = useCallback((file: File) => {
    setImportFileName(file.name);
    const ext = file.name.split(".").pop()?.toLowerCase();

    if (ext === "csv") {
      Papa.parse<FabricRecord>(file, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
          const mapped = mapColumns(results.data);
          setImportPreview(mapped);
          toast.success(`Parsed ${mapped.length} rows from CSV`);
        },
        error: (err) => toast.error(`CSV parse error: ${err.message}`),
      });
    } else if (ext === "xlsx" || ext === "xls") {
      const reader = new FileReader();
      reader.onload = (evt) => {
        const data = evt.target?.result;
        const workbook = XLSX.read(data, { type: "binary" });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json<FabricRecord>(sheet);
        const mapped = mapColumns(rows);
        setImportPreview(mapped);
        toast.success(`Parsed ${mapped.length} rows from XLSX`);
      };
      reader.readAsBinaryString(file);
    } else {
      toast.error("Unsupported file type. Please upload a CSV or XLSX file.");
    }
  }, []);

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) processFile(file);
    },
    [processFile],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files?.[0];
      if (file) processFile(file);
    },
    [processFile],
  );

  // ─── Import handler ────────────────────────────────────────────
  const handleImport = useCallback(async () => {
    if (!selectedVendorId || importPreview.length === 0) return;

    setImporting(true);
    try {
      const res = await axios.post<ImportResult>(
        "/api/pricing/import/fabrics",
        {
          vendorId: selectedVendorId,
          fabrics: importPreview,
          clearExisting,
        },
        { timeout: 300000 },
      );

      if (res.data.success) {
        setImportResult(res.data);
        toast.success(`Imported ${res.data.created} fabrics!`);
        fetchFabrics();
      } else {
        toast.error("Import failed");
      }
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Import failed"));
    } finally {
      setImporting(false);
    }
  }, [selectedVendorId, importPreview, clearExisting, fetchFabrics]);

  const resetImport = useCallback(() => {
    setImportPreview([]);
    setImportFileName("");
    setImportResult(null);
    setClearExisting(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  // ─── Detected columns preview ──────────────────────────────────
  const detectedColumns = useMemo(() => {
    if (importPreview.length === 0) return [];
    return Object.keys(importPreview[0]);
  }, [importPreview]);

  const hasFabricName = detectedColumns.includes("fabricName");
  const hasGrade = detectedColumns.includes("grade");

  const showEmpty = !loading && selectedVendorId && fabrics.length === 0;
  const hasActiveFilter = Boolean(searchQuery || selectedGrade);

  // ─── Render ────────────────────────────────────────────────────
  return (
    <div className="py-2 font-serif space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl text-sh-blue font-semibold flex items-center gap-2">
            <Palette className="w-6 h-6" />
            Fabric Catalog
          </h1>
          <p className="text-sm text-sh-gray mt-1">
            Browse and import vendor fabric catalogs. Each fabric maps to a grade tier for pricing.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <label htmlFor="fabric-vendor" className="sr-only">
            Vendor
          </label>
          <select
            id="fabric-vendor"
            value={selectedVendorId ?? ""}
            onChange={(e) => {
              setSelectedVendorId(e.target.value ? Number(e.target.value) : null);
              setSearchQuery("");
              setSelectedGrade("");
            }}
            className="border border-sh-gray rounded-lg px-3 py-2 text-sm bg-white text-sh-black min-w-[200px]"
          >
            <option value="">Select a vendor...</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>

          <Button
            variant="primary"
            onClick={() => {
              setShowImport(!showImport);
              resetImport();
            }}
            disabled={!selectedVendorId}
          >
            <Upload className="w-4 h-4 mr-2" />
            Import Fabrics
          </Button>
        </div>
      </div>

      {/* Import panel */}
      {showImport && selectedVendorId && (
        <ImportPanel
          fileInputRef={fileInputRef}
          importPreview={importPreview}
          importFileName={importFileName}
          importResult={importResult}
          importing={importing}
          clearExisting={clearExisting}
          isDragging={isDragging}
          detectedColumns={detectedColumns}
          hasFabricName={hasFabricName}
          hasGrade={hasGrade}
          onClose={() => {
            setShowImport(false);
            resetImport();
          }}
          onFileInput={handleFileInput}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onReset={resetImport}
          onClearExistingChange={setClearExisting}
          onImport={handleImport}
        />
      )}

      {/* Search + filter bar */}
      {selectedVendorId && (
        <FabricFilterBar
          searchQuery={searchQuery}
          selectedGrade={selectedGrade}
          gradeTiers={gradeTiers}
          gradeBreakdown={gradeBreakdown}
          total={total}
          onSearchChange={setSearchQuery}
          onGradeChange={setSelectedGrade}
        />
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-sh-blue mr-3" />
          <span className="text-sh-gray">Loading fabrics...</span>
        </div>
      )}

      {/* Empty state */}
      {showEmpty && <FabricEmptyState filtered={hasActiveFilter} />}

      {/* No vendor selected */}
      {!selectedVendorId && !vendorLoading && (
        <div className="text-center py-16 text-sh-gray">
          Select a vendor above to browse or import fabrics.
        </div>
      )}

      {/* Fabric table */}
      {!loading && fabrics.length > 0 && <FabricTable fabrics={fabrics} />}
    </div>
  );
}
