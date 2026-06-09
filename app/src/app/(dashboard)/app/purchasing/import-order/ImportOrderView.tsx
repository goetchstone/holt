"use client";

// /app/src/app/(dashboard)/app/purchasing/import-order/ImportOrderView.tsx
//
// Unified wholesale order import (CSV or PDF). App Router port; reads the shared
// /api/purchasing/import-wholesale-order + /api/purchasing/preview-* +
// /api/purchasing/import-* + /api/departments + /api/categories REST endpoints,
// which stay REST. Chrome from the (dashboard) layout.
//
// CSV: parsed client-side with PapaParse, previewed, then imported via
//      /api/purchasing/import-wholesale-order
// PDF: vendor format selected, uploaded to the correct preview endpoint,
//      previewed with department/category selection, then imported.
//      Supports NuORDER and Z Supply invoice formats.

import { useState, useEffect, type ChangeEvent } from "react";
import { Button } from "@/components/ui/button";
import FormInput from "@/components/form/FormInput";
import { toast } from "react-toastify";
import axios from "axios";
import Papa from "papaparse";
import { Upload, CheckCircle } from "lucide-react";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";

// -- CSV types --
interface OrderRow {
  [key: string]: string;
}

const CSV_COLUMN_HEADERS: { key: string; label: string }[] = [
  { key: "Vendor", label: "Vendor" },
  { key: "Style", label: "Style/SKU" },
  { key: "Description", label: "Description" },
  { key: "Qty", label: "Qty" },
  { key: "Wholesale", label: "Cost" },
  { key: "Retail", label: "Retail" },
  { key: "UPC", label: "UPC" },
  { key: "Color", label: "Color" },
  { key: "Size", label: "Size" },
  { key: "Season", label: "Season" },
];

// -- PDF types --
interface ParsedPdfItem {
  productName: string;
  styleNumber: string;
  msrp: number;
  color: string;
  colorCode: string;
  unitPrice: number;
  totalUnits: number;
  totalPrice: number;
  sizes: { size: string; quantity: number }[];
}

interface ParsedPdf {
  vendorName: string;
  orderNumber: string;
  poNumber: string;
  orderDate: string;
  deliveryStart: string;
  deliveryEnd: string;
  terms: string;
  totalUnits: number;
  totalPrice: number;
  items: ParsedPdfItem[];
}

interface DeptOption {
  id: number;
  name: string;
}
interface CatOption {
  id: number;
  name: string;
  departmentId: number;
}

interface ImportResult {
  poId: number;
  poNumber: string;
  vendor: string;
  itemCount: number;
  productsCreated: number;
  variantsCreated: number;
  totalUnits: number;
  totalCost: number;
  replaced: boolean;
  purchaseOrders?: { poNumber: string; itemCount: number }[];
  productsExisting?: number;
  errors?: string[];
  warnings?: string[];
}

type PdfVendorFormat = "nuorder" | "zsupply";

const PDF_FORMAT_OPTIONS: { value: PdfVendorFormat; label: string }[] = [
  { value: "nuorder", label: "NuORDER" },
  { value: "zsupply", label: "Z Supply" },
];

const PDF_ENDPOINTS: Record<PdfVendorFormat, { preview: string; import: string }> = {
  nuorder: {
    preview: "/api/purchasing/preview-nuorder",
    import: "/api/purchasing/import-nuorder",
  },
  zsupply: {
    preview: "/api/purchasing/preview-zsupply",
    import: "/api/purchasing/import-zsupply",
  },
};

export function ImportOrderView() {
  const fmt = useMoneyFormatter();
  const [file, setFile] = useState<File | null>(null);
  const [fileType, setFileType] = useState<"csv" | "pdf" | null>(null);
  const [pdfFormat, setPdfFormat] = useState<PdfVendorFormat>("nuorder");

  // CSV state
  const [csvData, setCsvData] = useState<OrderRow[]>([]);
  const [defaultVendor, setDefaultVendor] = useState("");
  const [defaultDepartment, setDefaultDepartment] = useState("");
  const [defaultCategory, setDefaultCategory] = useState("");

  // PDF state
  const [pdfPreview, setPdfPreview] = useState<ParsedPdf | null>(null);
  const [departments, setDepartments] = useState<DeptOption[]>([]);
  const [categories, setCategories] = useState<CatOption[]>([]);
  const [selectedDeptId, setSelectedDeptId] = useState<number | null>(null);
  const [selectedCatId, setSelectedCatId] = useState<number | null>(null);
  // Per-item category overrides: index -> categoryId
  const [itemCategories, setItemCategories] = useState<Record<number, number>>({});

  // Shared state
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  // Load departments and categories for PDF flow
  useEffect(() => {
    Promise.all([fetch("/api/departments?all=true"), fetch("/api/categories?all=true")])
      .then(([dRes, cRes]) => Promise.all([dRes.json(), cRes.json()]))
      .then(([dData, cData]) => {
        setDepartments(
          (dData.departments || dData || []).map((d: any) => ({ id: d.id, name: d.name })),
        );
        setCategories(
          (cData.categories || cData || []).map((c: any) => ({
            id: c.id,
            name: c.name,
            departmentId: c.departmentId,
          })),
        );
      })
      .catch(() => {});
  }, []);

  const filteredCategories = selectedDeptId
    ? categories.filter((c) => c.departmentId === selectedDeptId)
    : [];

  const handleFileSelect = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    setResult(null);
    setCsvData([]);
    setPdfPreview(null);

    if (f.name.toLowerCase().endsWith(".pdf")) {
      setFileType("pdf");
    } else {
      setFileType("csv");
      // Parse CSV client-side
      Papa.parse(f, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (h: string) => h.trim(),
        complete: (results) => {
          const rows = results.data.filter((row) =>
            Object.values(row as Record<string, unknown>).some((v) => String(v).trim() !== ""),
          ) as OrderRow[];
          setCsvData(rows);
          if (rows.length > 0) {
            toast.info(`Parsed ${rows.length} rows. Review and click Import.`);
          } else {
            toast.warn("No valid data found in the CSV.");
          }
        },
        error: (error: unknown) =>
          toast.error(
            `Error parsing CSV: ${error instanceof Error ? error.message : "Unknown error"}`,
          ),
      });
    }
  };

  const handleCsvImport = async () => {
    if (csvData.length === 0) return;
    setLoading(true);
    try {
      const res = await axios.post("/api/purchasing/import-wholesale-order", {
        rows: csvData,
        defaultVendor: defaultVendor || undefined,
        defaultDepartment: defaultDepartment || undefined,
        defaultCategory: defaultCategory || undefined,
      });
      const data = res.data;
      const poSummary = data.purchaseOrders
        .map((po: { poNumber: string; itemCount: number }) => `${po.poNumber} (${po.itemCount})`)
        .join(", ");
      toast.success(
        `Created ${data.purchaseOrders.length} PO(s): ${poSummary}. ` +
          `Products: ${data.productsCreated} new, ${data.productsExisting} existing.`,
      );
      if (data.warnings?.length) {
        toast.warn(data.warnings[0]);
      }
      setResult(data);
      setCsvData([]);
    } catch (err: unknown) {
      const msg =
        axios.isAxiosError(err) && err.response?.data?.error
          ? err.response.data.error
          : "Import failed";
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  const handlePdfParse = async () => {
    if (!file) return;
    setLoading(true);
    setPdfPreview(null);
    const formData = new FormData();
    formData.append("file", file);
    try {
      const res = await fetch(PDF_ENDPOINTS[pdfFormat].preview, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Parse failed");
      }
      const data = await res.json();
      setPdfPreview(data);
      toast.info(`Parsed ${data.items.length} items from PDF. Select department and confirm.`);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to parse PDF");
    } finally {
      setLoading(false);
    }
  };

  const handlePdfImport = async () => {
    if (!file || !selectedDeptId || !selectedCatId) return;
    setLoading(true);
    const formData = new FormData();
    formData.append("file", file);
    formData.append("departmentId", String(selectedDeptId));
    formData.append("categoryId", String(selectedCatId));
    // Send per-item category overrides as JSON
    if (Object.keys(itemCategories).length > 0) {
      formData.append("itemCategories", JSON.stringify(itemCategories));
    }
    try {
      const res = await fetch(PDF_ENDPOINTS[pdfFormat].import, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Import failed");
      }
      const data = await res.json();
      setResult(data);
      setPdfPreview(null);
      toast.success(`PO ${data.poNumber} imported: ${data.totalUnits} units`);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Import failed");
    } finally {
      setLoading(false);
    }
  };

  const reset = () => {
    setFile(null);
    setFileType(null);
    setPdfFormat("nuorder");
    setCsvData([]);
    setPdfPreview(null);
    setResult(null);
    setSelectedDeptId(null);
    setSelectedCatId(null);
    setItemCategories({});
  };

  const csvHeaders = csvData.length > 0 ? getMatchedHeaders(csvData[0]) : CSV_COLUMN_HEADERS;

  return (
    <div className="space-y-6">
      {/* File upload -- always visible unless we have a result */}
      {!result && (
        <>
          <p className="text-sm text-sh-gray">
            Upload a CSV or PDF purchase order. CSV files are parsed client-side. PDF invoices
            require selecting the vendor format before parsing.
          </p>
          <div className="flex items-center gap-4">
            <label className="flex cursor-pointer items-center gap-2 rounded border border-gray-300 px-4 py-2 text-sm hover:bg-sh-stripe">
              <Upload className="h-4 w-4" />
              {file ? file.name : "Choose CSV or PDF..."}
              <input
                type="file"
                accept=".csv,.pdf"
                className="hidden"
                onChange={handleFileSelect}
              />
            </label>
            {loading && <span className="text-sm text-sh-gray">Parsing...</span>}
          </div>
          {fileType === "pdf" && !pdfPreview && (
            <div className="flex items-center gap-4">
              <div>
                <label className="mb-1 block text-xs text-sh-gray">PDF Vendor Format</label>
                <select
                  value={pdfFormat}
                  onChange={(e) => setPdfFormat(e.target.value as PdfVendorFormat)}
                  className="rounded border border-gray-300 px-3 py-2 text-sm focus:border-sh-gold focus:outline-none"
                >
                  {PDF_FORMAT_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <Button onClick={handlePdfParse} disabled={loading} className="mt-5">
                {loading ? "Parsing..." : "Preview"}
              </Button>
            </div>
          )}
        </>
      )}

      {/* CSV preview */}
      {fileType === "csv" && csvData.length > 0 && !result && (
        <>
          <div className="rounded border border-gray-200 bg-white p-4">
            <h3 className="mb-3 text-sm font-semibold text-sh-navy">
              Defaults for missing columns
            </h3>
            <div className="grid grid-cols-3 gap-4">
              <FormInput
                label="Default Vendor"
                name="defaultVendor"
                value={defaultVendor}
                onChange={setDefaultVendor}
              />
              <FormInput
                label="Default Department"
                name="defaultDepartment"
                value={defaultDepartment}
                onChange={setDefaultDepartment}
              />
              <FormInput
                label="Default Category"
                name="defaultCategory"
                value={defaultCategory}
                onChange={setDefaultCategory}
              />
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs text-sh-gray">
                  {csvHeaders.map((h) => (
                    <th key={h.key} className="px-2 py-2">
                      {h.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {csvData.slice(0, 50).map((row, i) => (
                  <tr key={i} className={i % 2 === 0 ? "bg-sh-stripe" : "bg-white"}>
                    {csvHeaders.map((h) => (
                      <td key={h.key} className="px-2 py-2">
                        {String(row[h.key] || "")}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {csvData.length > 50 && (
              <p className="mt-2 text-xs text-sh-gray">Showing first 50 of {csvData.length} rows</p>
            )}
          </div>

          <div className="flex items-center gap-3">
            <Button onClick={handleCsvImport} disabled={loading}>
              {loading ? "Importing..." : `Import ${csvData.length} rows`}
            </Button>
            <Button variant="outline" onClick={reset}>
              Cancel
            </Button>
          </div>
        </>
      )}

      {/* PDF preview */}
      {fileType === "pdf" && pdfPreview && !result && (
        <>
          <div className="rounded border border-sh-gold/30 bg-amber-50 p-4">
            <h3 className="mb-2 font-serif text-base font-semibold text-sh-navy">
              {pdfPreview.vendorName || "Vendor"} -- Order {pdfPreview.orderNumber}
            </h3>
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <span className="text-sh-gray">PO#:</span> {pdfPreview.poNumber}
              </div>
              <div>
                <span className="text-sh-gray">Date:</span> {pdfPreview.orderDate}
              </div>
              <div>
                <span className="text-sh-gray">Delivery:</span> {pdfPreview.deliveryStart} -{" "}
                {pdfPreview.deliveryEnd}
              </div>
              <div>
                <span className="text-sh-gray">Total Units:</span> {pdfPreview.totalUnits}
              </div>
              <div>
                <span className="text-sh-gray">Total Cost:</span> {fmt(pdfPreview.totalPrice)}
              </div>
              <div>
                <span className="text-sh-gray">Terms:</span> {pdfPreview.terms}
              </div>
            </div>
          </div>

          {/* Default department and category */}
          <div className="rounded border border-gray-200 bg-white p-4">
            <h4 className="mb-3 text-sm font-semibold text-sh-navy">
              Default department and category
            </h4>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="mb-1 block text-xs text-sh-gray">Department</label>
                <select
                  value={selectedDeptId || ""}
                  onChange={(e) => {
                    setSelectedDeptId(Number.parseInt(e.target.value) || null);
                    setSelectedCatId(null);
                    setItemCategories({});
                  }}
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-sh-gold focus:outline-none"
                >
                  <option value="">Select department...</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs text-sh-gray">Default Category</label>
                <select
                  value={selectedCatId || ""}
                  onChange={(e) => {
                    setSelectedCatId(Number.parseInt(e.target.value) || null);
                    setItemCategories({});
                  }}
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-sh-gold focus:outline-none"
                  disabled={!selectedDeptId}
                >
                  <option value="">
                    {selectedDeptId ? "Select category..." : "Select department first"}
                  </option>
                  {filteredCategories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs text-sh-gray">
                  <th className="px-2 py-2">Style #</th>
                  <th className="px-2 py-2">Product</th>
                  <th className="px-2 py-2">Color</th>
                  <th className="px-2 py-2 text-right">MSRP</th>
                  <th className="px-2 py-2 text-right">Cost</th>
                  <th className="px-2 py-2 text-center">Units</th>
                  <th className="px-2 py-2">Sizes</th>
                  <th className="px-2 py-2">Category</th>
                </tr>
              </thead>
              <tbody>
                {pdfPreview.items.map((item, i) => (
                  <tr
                    key={item.styleNumber + i}
                    className={i % 2 === 0 ? "bg-sh-stripe" : "bg-white"}
                  >
                    <td className="px-2 py-2 font-mono text-xs">{item.styleNumber}</td>
                    <td className="px-2 py-2">{item.productName}</td>
                    <td className="px-2 py-2">{item.color || item.colorCode}</td>
                    <td className="px-2 py-2 text-right">{fmt(item.msrp)}</td>
                    <td className="px-2 py-2 text-right">{fmt(item.unitPrice)}</td>
                    <td className="px-2 py-2 text-center">{item.totalUnits}</td>
                    <td className="px-2 py-2 text-xs text-sh-gray">
                      {item.sizes.map((s) => `${s.size}:${s.quantity}`).join(", ")}
                    </td>
                    <td className="px-2 py-2">
                      <select
                        value={itemCategories[i] ?? selectedCatId ?? ""}
                        onChange={(e) => {
                          const catId = Number.parseInt(e.target.value) || null;
                          setItemCategories((prev) => {
                            const next = { ...prev };
                            if (catId && catId !== selectedCatId) {
                              next[i] = catId;
                            } else {
                              delete next[i];
                            }
                            return next;
                          });
                        }}
                        disabled={!selectedDeptId}
                        className="w-full rounded border border-gray-300 px-1 py-1 text-xs focus:border-sh-gold focus:outline-none"
                      >
                        <option value="">--</option>
                        {filteredCategories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center gap-3">
            <Button
              onClick={handlePdfImport}
              disabled={!selectedDeptId || !selectedCatId || loading}
            >
              {loading
                ? "Importing..."
                : `Import ${pdfPreview.items.length} items (${pdfPreview.totalUnits} units)`}
            </Button>
            <Button variant="outline" onClick={reset}>
              Cancel
            </Button>
          </div>
        </>
      )}

      {/* Result */}
      {result && (
        <div className="space-y-4">
          <div className="rounded border border-green-200 bg-green-50 p-4">
            <div className="mb-2 flex items-center gap-2">
              <CheckCircle className="h-5 w-5 text-green-600" />
              <span className="font-medium text-green-800">
                {result.replaced ? "PO replaced" : "PO created"} successfully
              </span>
            </div>
            <dl className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm">
              {result.poNumber && (
                <>
                  <dt className="text-sh-gray">PO Number</dt>
                  <dd className="font-medium">
                    <a
                      href={`/app/purchasing/orders/${result.poId}`}
                      className="text-sh-gold underline"
                    >
                      {result.poNumber}
                    </a>
                  </dd>
                </>
              )}
              {result.purchaseOrders && (
                <>
                  <dt className="text-sh-gray">Purchase Orders</dt>
                  <dd>
                    {result.purchaseOrders
                      .map((po) => `${po.poNumber} (${po.itemCount})`)
                      .join(", ")}
                  </dd>
                </>
              )}
              {result.vendor && (
                <>
                  <dt className="text-sh-gray">Vendor</dt>
                  <dd>{result.vendor}</dd>
                </>
              )}
              <dt className="text-sh-gray">Line Items</dt>
              <dd>{result.itemCount}</dd>
              {result.totalUnits !== undefined && (
                <>
                  <dt className="text-sh-gray">Total Units</dt>
                  <dd>{result.totalUnits}</dd>
                </>
              )}
              <dt className="text-sh-gray">Total Cost</dt>
              <dd>{fmt(result.totalCost)}</dd>
              <dt className="text-sh-gray">Products Created</dt>
              <dd>{result.productsCreated}</dd>
              {result.variantsCreated !== undefined && (
                <>
                  <dt className="text-sh-gray">Variants Created</dt>
                  <dd>{result.variantsCreated}</dd>
                </>
              )}
            </dl>
          </div>
          {result.warnings && result.warnings.length > 0 && (
            <div className="rounded border border-amber-200 bg-amber-50 p-4">
              <h4 className="mb-1 text-sm font-semibold text-amber-800">Warnings</h4>
              <ul className="list-inside list-disc space-y-0.5 text-sm text-amber-700">
                {result.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}
          <Button variant="outline" onClick={reset}>
            Import Another
          </Button>
        </div>
      )}

      {/* Help text when nothing loaded */}
      {!file && !result && (
        <div className="rounded border border-gray-200 bg-sh-linen p-4 text-sm text-sh-gray">
          <h3 className="mb-2 font-semibold text-sh-black">Supported formats</h3>
          <div className="grid grid-cols-2 gap-6">
            <div>
              <h4 className="mb-1 font-medium text-sh-navy">CSV</h4>
              <p className="mb-2">
                Exports from NuOrder, JOOR, or any wholesale platform. Column names are
                auto-detected.
              </p>
              <div className="grid grid-cols-2 gap-y-0.5 text-xs">
                <span>
                  <strong>Vendor:</strong> Vendor, Brand
                </span>
                <span>
                  <strong>SKU:</strong> Style, SKU, Item #
                </span>
                <span>
                  <strong>Cost:</strong> Wholesale, Unit Cost
                </span>
                <span>
                  <strong>Retail:</strong> Retail, MSRP
                </span>
                <span>
                  <strong>Qty:</strong> Qty, Quantity, Order Qty, Ordered, Total Qty
                </span>
                <span>
                  <strong>UPC:</strong> UPC, Barcode
                </span>
              </div>
            </div>
            <div>
              <h4 className="mb-1 font-medium text-sh-navy">PDF</h4>
              <p className="mb-2">Select the vendor format before parsing. Supported formats:</p>
              <ul className="list-inside list-disc space-y-0.5 text-xs">
                <li>NuORDER purchase orders (Favorite Daughter, etc.)</li>
                <li>Z Supply invoices (size grid format)</li>
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function getMatchedHeaders(sampleRow: Record<string, string>): { key: string; label: string }[] {
  const keys = Object.keys(sampleRow);
  return keys
    .filter((k) => String(sampleRow[k]).trim() !== "")
    .concat(keys.filter((k) => String(sampleRow[k]).trim() === ""))
    .filter((k, i, arr) => arr.indexOf(k) === i)
    .slice(0, 12)
    .map((k) => ({ key: k, label: k }));
}
