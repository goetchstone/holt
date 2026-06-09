"use client";

// /app/src/app/(dashboard)/app/purchasing/import-apparel/ImportApparelView.tsx
//
// Two-step import for apparel vendor purchase orders (NuORDER + Z Supply
// formats). App Router port; reads the shared /api/purchasing/preview-* +
// /api/purchasing/import-* + /api/departments + /api/categories REST endpoints,
// which stay REST. Chrome from the (dashboard) layout.
//
// Step 1: Select vendor format, upload PDF, see parsed preview.
// Step 2: Select department and category, then confirm import.

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "react-toastify";
import { Upload, CheckCircle } from "lucide-react";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";

interface ParsedItem {
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

interface ParsedPO {
  vendorName: string;
  orderNumber: string;
  poNumber: string;
  orderDate: string;
  deliveryStart: string;
  deliveryEnd: string;
  terms: string;
  totalUnits: number;
  totalPrice: number;
  items: ParsedItem[];
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
}

type VendorFormat = "nuorder" | "zsupply";

const VENDOR_FORMATS: { value: VendorFormat; label: string }[] = [
  { value: "nuorder", label: "NuORDER" },
  { value: "zsupply", label: "Z Supply" },
];

const FORMAT_ENDPOINTS: Record<VendorFormat, { preview: string; import: string }> = {
  nuorder: { preview: "/api/purchasing/preview-nuorder", import: "/api/purchasing/import-nuorder" },
  zsupply: { preview: "/api/purchasing/preview-zsupply", import: "/api/purchasing/import-zsupply" },
};

export function ImportApparelView() {
  const fmt = useMoneyFormatter();
  const [vendorFormat, setVendorFormat] = useState<VendorFormat>("nuorder");
  const [file, setFile] = useState<File | null>(null);
  const [parsing, setParsing] = useState(false);
  const [preview, setPreview] = useState<ParsedPO | null>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  const [departments, setDepartments] = useState<DeptOption[]>([]);
  const [categories, setCategories] = useState<CatOption[]>([]);
  const [selectedDeptId, setSelectedDeptId] = useState<number | null>(null);
  const [selectedCatId, setSelectedCatId] = useState<number | null>(null);

  useEffect(() => {
    Promise.all([fetch("/api/departments?all=true"), fetch("/api/categories?all=true")])
      .then(([dRes, cRes]) => Promise.all([dRes.json(), cRes.json()]))
      .then(([dData, cData]) => {
        const depts = (dData.departments || dData || []).map((d: any) => ({
          id: d.id,
          name: d.name,
        }));
        const cats = (cData.categories || cData || []).map((c: any) => ({
          id: c.id,
          name: c.name,
          departmentId: c.departmentId,
        }));
        setDepartments(depts);
        setCategories(cats);
      })
      .catch(() => {});
  }, []);

  const filteredCategories = selectedDeptId
    ? categories.filter((c) => c.departmentId === selectedDeptId)
    : [];

  const handleParse = async () => {
    if (!file) return;
    setParsing(true);
    setPreview(null);
    setResult(null);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch(FORMAT_ENDPOINTS[vendorFormat].preview, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Parse failed");
      }
      const data = await res.json();
      setPreview(data);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to parse PDF");
    } finally {
      setParsing(false);
    }
  };

  const handleImport = async () => {
    if (!file || !selectedDeptId || !selectedCatId) return;
    setImporting(true);

    const formData = new FormData();
    formData.append("file", file);
    formData.append("departmentId", String(selectedDeptId));
    formData.append("categoryId", String(selectedCatId));

    try {
      const res = await fetch(FORMAT_ENDPOINTS[vendorFormat].import, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Import failed");
      }
      const data = await res.json();
      setResult(data);
      setPreview(null);
      toast.success(`PO ${data.poNumber} imported: ${data.totalUnits} units`);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Import failed");
    } finally {
      setImporting(false);
    }
  };

  const reset = () => {
    setFile(null);
    setPreview(null);
    setResult(null);
    setSelectedDeptId(null);
    setSelectedCatId(null);
    setVendorFormat("nuorder");
  };

  return (
    <div className="space-y-6">
      {/* Step 1: Upload */}
      {!preview && !result && (
        <>
          <p className="text-sm text-sh-gray">
            Upload an apparel vendor purchase order or invoice PDF. Select the vendor format,
            preview the parsed items, then assign a department and category before importing.
          </p>
          <div className="mb-4">
            <label className="mb-1 block text-xs text-sh-gray">Vendor Format</label>
            <select
              value={vendorFormat}
              onChange={(e) => setVendorFormat(e.target.value as VendorFormat)}
              className="rounded border border-gray-300 px-3 py-2 text-sm focus:border-sh-gold focus:outline-none"
            >
              {VENDOR_FORMATS.map((vf) => (
                <option key={vf.value} value={vf.value}>
                  {vf.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-4">
            <label className="flex cursor-pointer items-center gap-2 rounded border border-gray-300 px-4 py-2 text-sm hover:bg-sh-stripe">
              <Upload className="h-4 w-4" />
              {file ? file.name : "Choose PDF..."}
              <input
                type="file"
                accept=".pdf"
                className="hidden"
                onChange={(e) => {
                  setFile(e.target.files?.[0] || null);
                  setResult(null);
                }}
              />
            </label>
            <Button onClick={handleParse} disabled={!file || parsing}>
              {parsing ? "Parsing..." : "Preview"}
            </Button>
          </div>
        </>
      )}

      {/* Step 2: Preview + department/category selection */}
      {preview && !result && (
        <>
          <div className="rounded border border-sh-gold/30 bg-amber-50 p-4">
            <h3 className="mb-2 font-serif text-base font-semibold text-sh-navy">
              {preview.vendorName || "Vendor"} -- Order {preview.orderNumber}
            </h3>
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <span className="text-sh-gray">PO#:</span> {preview.poNumber}
              </div>
              <div>
                <span className="text-sh-gray">Date:</span> {preview.orderDate}
              </div>
              <div>
                <span className="text-sh-gray">Delivery:</span> {preview.deliveryStart} -{" "}
                {preview.deliveryEnd}
              </div>
              <div>
                <span className="text-sh-gray">Total Units:</span> {preview.totalUnits}
              </div>
              <div>
                <span className="text-sh-gray">Total Cost:</span> {fmt(preview.totalPrice)}
              </div>
              <div>
                <span className="text-sh-gray">Terms:</span> {preview.terms}
              </div>
            </div>
          </div>

          {/* Item preview table */}
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
                </tr>
              </thead>
              <tbody>
                {preview.items.map((item, i) => (
                  <tr key={item.styleNumber} className={i % 2 === 0 ? "bg-sh-stripe" : "bg-white"}>
                    <td className="px-2 py-2 font-mono text-xs">{item.styleNumber}</td>
                    <td className="px-2 py-2">{item.productName}</td>
                    <td className="px-2 py-2">{item.color}</td>
                    <td className="px-2 py-2 text-right">{fmt(item.msrp)}</td>
                    <td className="px-2 py-2 text-right">{fmt(item.unitPrice)}</td>
                    <td className="px-2 py-2 text-center">{item.totalUnits}</td>
                    <td className="px-2 py-2 text-xs text-sh-gray">
                      {item.sizes.map((s) => `${s.size}:${s.quantity}`).join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Department and category selection */}
          <div className="rounded border border-gray-200 bg-white p-4">
            <h4 className="mb-3 text-sm font-semibold text-sh-navy">
              Assign department and category for new products
            </h4>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="mb-1 block text-xs text-sh-gray">Department</label>
                <select
                  value={selectedDeptId || ""}
                  onChange={(e) => {
                    const id = Number.parseInt(e.target.value) || null;
                    setSelectedDeptId(id);
                    setSelectedCatId(null);
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
                <label className="mb-1 block text-xs text-sh-gray">Category</label>
                <select
                  value={selectedCatId || ""}
                  onChange={(e) => setSelectedCatId(Number.parseInt(e.target.value) || null)}
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

          <div className="flex items-center gap-3">
            <Button
              onClick={handleImport}
              disabled={!selectedDeptId || !selectedCatId || importing}
            >
              {importing
                ? "Importing..."
                : `Import ${preview.items.length} items (${preview.totalUnits} units)`}
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
              <dt className="text-sh-gray">PO Number</dt>
              <dd className="font-medium">
                <a
                  href={`/app/purchasing/orders/${result.poId}`}
                  className="text-sh-gold underline"
                >
                  {result.poNumber}
                </a>
              </dd>
              <dt className="text-sh-gray">Vendor</dt>
              <dd>{result.vendor}</dd>
              <dt className="text-sh-gray">Line Items</dt>
              <dd>{result.itemCount}</dd>
              <dt className="text-sh-gray">Total Units</dt>
              <dd>{result.totalUnits}</dd>
              <dt className="text-sh-gray">Total Cost</dt>
              <dd>{fmt(result.totalCost)}</dd>
              <dt className="text-sh-gray">Products Created</dt>
              <dd>{result.productsCreated}</dd>
              <dt className="text-sh-gray">Variants Created</dt>
              <dd>{result.variantsCreated}</dd>
            </dl>
          </div>
          <Button variant="outline" onClick={reset}>
            Import Another
          </Button>
        </div>
      )}
    </div>
  );
}
