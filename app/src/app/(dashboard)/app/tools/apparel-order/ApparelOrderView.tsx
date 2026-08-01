"use client";

// /app/src/app/(dashboard)/app/tools/apparel-order/ApparelOrderView.tsx
//
// Apparel Order Import body. Parses a vendor apparel order (PDF via the
// server-side vendor parsers, or CSV client-side with PapaParse), lets
// the buyer review + edit the normalized rows and pick the destination
// PO's vendor/department/category/location, then POSTs to commit.ts to
// create a BuyerDraftPurchaseOrder + BuyerDraftItem rows.
//
// Ported from furniture-configurator's pages/tools/apparel-order.tsx, cut
// down substantially: FC's version ran a second "match" pass against the
// Ordorite catalog (NEW vs UPDATE detection, style/color suggestions,
// XLSX file generation) because its output was a CSV headed straight into
// Ordorite. Holt's Buyer Drafts domain has no catalog-matching step --
// every row becomes a fresh DRAFT BuyerDraftItem, full stop -- so this
// view is: upload -> edit rows -> pick PO destination fields -> create.
// The buyer curates further (dept/category fixes, catalog links, status)
// in the existing Buyer Drafts workbench afterward.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import axios from "axios";
import Papa from "papaparse";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import {
  APPAREL_VENDOR_FORMATS,
  normalizeCsvRows,
  type ApparelOrderDraft,
  type ApparelOrderRow,
  type ApparelVendorFormatId,
} from "@/lib/apparelOrderVendors";

interface VendorOption {
  id: number;
  name: string;
  code: string | null;
}
interface StockLocationOption {
  id: number;
  code: string;
  name: string;
  storeLocationId: number;
}
interface StoreLocationOption {
  id: number;
  code: string;
  name: string;
}
interface DepartmentOption {
  id: number;
  name: string;
}
interface CategoryOption {
  id: number;
  name: string;
  departmentId: number;
}
interface BuyOption {
  id: number;
  name: string;
  season: string | null;
  year: number | null;
  status: string;
}

interface Lookups {
  vendors: VendorOption[];
  stockLocations: StockLocationOption[];
  storeLocations: StoreLocationOption[];
  departments: DepartmentOption[];
  categories: CategoryOption[];
  buys: BuyOption[];
}

interface CommitResult {
  po: { id: number; referenceNumber: string | null; vendorName: string };
  itemCount: number;
}

const FORMAT_BY_ID = new Map(APPAREL_VENDOR_FORMATS.map((f) => [f.id, f]));

export function ApparelOrderView() {
  const formatMoney = useMoneyFormatter();
  const [lookups, setLookups] = useState<Lookups | null>(null);
  const [formatId, setFormatId] = useState<ApparelVendorFormatId>("generic-csv");
  const [parsing, setParsing] = useState(false);
  const [draft, setDraft] = useState<ApparelOrderDraft | null>(null);
  const [rows, setRows] = useState<ApparelOrderRow[]>([]);
  const [csvWarning, setCsvWarning] = useState<string | null>(null);

  const [vendorId, setVendorId] = useState<string>("");
  const [vendorName, setVendorName] = useState<string>("");
  const [referenceNumber, setReferenceNumber] = useState<string>("");
  const [expectedShipMonth, setExpectedShipMonth] = useState<string>("");
  const [storeLocationId, setStoreLocationId] = useState<string>("");
  const [stockLocationId, setStockLocationId] = useState<string>("");
  const [departmentId, setDepartmentId] = useState<string>("");
  const [categoryId, setCategoryId] = useState<string>("");
  const [buyId, setBuyId] = useState<string>("");
  const [stockProgram, setStockProgram] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CommitResult | null>(null);

  const format = FORMAT_BY_ID.get(formatId);

  useEffect(() => {
    axios
      .get<Lookups>("/api/admin/buyer-drafts/lookups")
      .then((res) => setLookups(res.data))
      .catch((err) => toast.error(getErrorMessage(err, "Failed to load vendor/department lists")));
  }, []);

  const categoriesForDepartment = useMemo(() => {
    if (!lookups || !departmentId) return [];
    const dId = Number(departmentId);
    return lookups.categories.filter((c) => c.departmentId === dId);
  }, [lookups, departmentId]);

  const resetForNewDraft = useCallback(
    (d: ApparelOrderDraft, vendorsList: VendorOption[]) => {
      setDraft(d);
      setRows(d.rows);
      setResult(null);
      setReferenceNumber(d.poNumber || d.orderNumber || "");
      const wantedName = (format?.catalogVendorName || d.vendorName || "").trim().toLowerCase();
      const matched = wantedName
        ? vendorsList.find((v) => v.name.trim().toLowerCase() === wantedName)
        : undefined;
      if (matched) {
        setVendorId(String(matched.id));
        setVendorName(matched.name);
      } else {
        setVendorId("");
        setVendorName(format?.catalogVendorName || d.vendorName || "");
      }
      if (d.warnings && d.warnings.length > 0) {
        toast.warn(`${d.warnings.length} line(s) need a look — see warnings below the table.`);
      }
    },
    [format],
  );

  const handlePdfFile = useCallback(
    async (file: File) => {
      setParsing(true);
      setCsvWarning(null);
      try {
        const form = new FormData();
        form.append("format", formatId);
        form.append("file", file);
        const res = await axios.post<ApparelOrderDraft>("/api/tools/apparel-order/preview", form, {
          headers: { "Content-Type": "multipart/form-data" },
        });
        resetForNewDraft(res.data, lookups?.vendors ?? []);
        toast.success(`Parsed ${res.data.rows.length} line(s) from the PDF.`);
      } catch (err) {
        toast.error(getErrorMessage(err, "Failed to parse the PDF"));
      } finally {
        setParsing(false);
      }
    },
    [formatId, lookups, resetForNewDraft],
  );

  const handleCsvFile = useCallback(
    (file: File) => {
      setParsing(true);
      setCsvWarning(null);
      Papa.parse<Record<string, unknown>>(file, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
          setParsing(false);
          const normalized = normalizeCsvRows(results.data);
          if (normalized.rows.length === 0) {
            toast.error("No usable rows found in that CSV (missing a Style/SKU column?).");
            return;
          }
          if (normalized.vendorNames.length > 1) {
            setCsvWarning(
              `This CSV mixes ${normalized.vendorNames.length} vendors (${normalized.vendorNames.join(", ")}). ` +
                "The draft PO takes one vendor — remove the other rows or split the file.",
            );
          }
          resetForNewDraft(normalized, lookups?.vendors ?? []);
          toast.success(
            `Parsed ${normalized.rows.length} row(s)` +
              (normalized.skipped > 0 ? ` (${normalized.skipped} skipped — no Style/SKU)` : "") +
              ".",
          );
        },
        error: (err) => {
          setParsing(false);
          toast.error(err.message || "Failed to parse the CSV");
        },
      });
    },
    [lookups, resetForNewDraft],
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file || !format) return;
      if (format.accepts === "pdf") void handlePdfFile(file);
      else handleCsvFile(file);
    },
    [format, handlePdfFile, handleCsvFile],
  );

  const updateRow = useCallback((index: number, patch: Partial<ApparelOrderRow>) => {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }, []);

  const removeRow = useCallback((index: number) => {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const totals = useMemo(() => {
    const qty = rows.reduce((sum, r) => sum + (Number.isFinite(r.qty) ? r.qty : 0), 0);
    const cost = rows.reduce(
      (sum, r) => sum + (Number.isFinite(r.qty) && Number.isFinite(r.cost) ? r.qty * r.cost : 0),
      0,
    );
    return { qty, cost, count: rows.length };
  }, [rows]);

  const handleSubmit = useCallback(async () => {
    if (!draft || rows.length === 0) return;
    setSubmitting(true);
    try {
      const body = {
        draft: {
          vendorName: draft.vendorName,
          poNumber: draft.poNumber,
          orderNumber: draft.orderNumber,
          orderDate: draft.orderDate,
          season: draft.season,
          warnings: draft.warnings,
        },
        rows,
        po: {
          vendorId: vendorId ? Number(vendorId) : null,
          vendorName,
          referenceNumber: referenceNumber || null,
          expectedShipMonth: expectedShipMonth || null,
          storeLocationId: storeLocationId ? Number(storeLocationId) : null,
          buyId: buyId ? Number(buyId) : null,
        },
        item: {
          vendorId: vendorId ? Number(vendorId) : null,
          departmentId: departmentId ? Number(departmentId) : null,
          categoryId: categoryId ? Number(categoryId) : null,
          stockLocationId: stockLocationId ? Number(stockLocationId) : null,
          stockProgram,
        },
      };
      const res = await axios.post<CommitResult>("/api/tools/apparel-order/commit", body);
      setResult(res.data);
      toast.success(
        `Created draft PO with ${res.data.itemCount} item(s). Curate it in Buyer Drafts.`,
      );
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to create the draft PO"));
    } finally {
      setSubmitting(false);
    }
  }, [
    draft,
    rows,
    vendorId,
    vendorName,
    referenceNumber,
    expectedShipMonth,
    storeLocationId,
    stockLocationId,
    buyId,
    departmentId,
    categoryId,
    stockProgram,
  ]);

  const canSubmit =
    !!draft && rows.length > 0 && vendorName.trim() !== "" && !submitting && !result;

  return (
    <div className="py-2 space-y-6 font-serif">
      <h1 className="text-2xl text-sh-blue font-semibold">Apparel Order Import</h1>
      <p className="text-sm text-sh-gray max-w-3xl">
        Upload a vendor apparel order (PDF or CSV). This creates a draft Purchase Order and one
        draft item per size/part-number in the{" "}
        <Link href="/app/admin/buyer-drafts" className="text-sh-blue underline">
          Buyer Drafts
        </Link>{" "}
        workbench — nothing is sent to the POS yet. From there, export as usual once the buyer has
        finished curating.
      </p>

      <div className="bg-white border border-sh-gray/20 rounded-lg p-5 space-y-4">
        <div>
          <label
            htmlFor="apparel-format"
            className="block text-sm font-semibold text-sh-black mb-1"
          >
            Vendor format
          </label>
          <select
            id="apparel-format"
            value={formatId}
            onChange={(e) => setFormatId(e.target.value as ApparelVendorFormatId)}
            className="w-full sm:w-96 border border-sh-gray/30 rounded px-3 py-2 text-sm"
          >
            {APPAREL_VENDOR_FORMATS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
          {format && <p className="text-xs text-sh-gray mt-1 max-w-2xl">{format.notes}</p>}
        </div>

        <div>
          <label htmlFor="apparel-file" className="block text-sm font-semibold text-sh-black mb-2">
            Upload {format?.accepts === "csv" ? "CSV" : "PDF"}
          </label>
          <input
            id="apparel-file"
            type="file"
            accept={format?.accepts === "csv" ? ".csv" : ".pdf"}
            onChange={handleFileChange}
            disabled={parsing}
            className="block w-full text-sm text-sh-gray file:mr-4 file:py-2 file:px-4
              file:rounded file:border-0 file:text-sm file:font-semibold
              file:bg-sh-blue file:text-white hover:file:bg-sh-navy
              disabled:opacity-50"
          />
          {parsing && <p className="text-sh-gray text-sm mt-2">Parsing...</p>}
        </div>
      </div>

      {csvWarning && (
        <div className="bg-yellow-50 border border-yellow-300 rounded-lg p-4 text-sm text-yellow-800">
          {csvWarning}
        </div>
      )}

      {draft && draft.warnings && draft.warnings.length > 0 && (
        <div className="bg-yellow-50 border border-yellow-300 rounded-lg p-4 text-sm text-yellow-800">
          <p className="font-semibold mb-1">Parser warnings</p>
          <ul className="list-disc list-inside space-y-0.5">
            {draft.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {draft && (
        <>
          <div className="bg-white border border-sh-gray/20 rounded-lg p-5">
            <h2 className="text-sm font-semibold text-sh-black mb-3">Draft purchase order</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-semibold text-sh-gray mb-1">Vendor</label>
                <select
                  value={vendorId}
                  onChange={(e) => {
                    setVendorId(e.target.value);
                    const v = lookups?.vendors.find((x) => String(x.id) === e.target.value);
                    if (v) setVendorName(v.name);
                  }}
                  className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
                >
                  <option value="">— Free text below —</option>
                  {lookups?.vendors.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  value={vendorName}
                  onChange={(e) => {
                    setVendorId("");
                    setVendorName(e.target.value);
                  }}
                  placeholder="Vendor name"
                  className="mt-2 w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-sh-gray mb-1">
                  Reference number (PO#)
                </label>
                <input
                  type="text"
                  value={referenceNumber}
                  onChange={(e) => setReferenceNumber(e.target.value)}
                  className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-sh-gray mb-1">
                  Expected ship month
                </label>
                <input
                  type="month"
                  value={expectedShipMonth}
                  onChange={(e) => setExpectedShipMonth(e.target.value)}
                  className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-sh-gray mb-1">
                  Ship-to store
                </label>
                <select
                  value={storeLocationId}
                  onChange={(e) => setStoreLocationId(e.target.value)}
                  className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
                >
                  <option value="">—</option>
                  {lookups?.storeLocations.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-sh-gray mb-1">
                  Stock location (all items)
                </label>
                <select
                  value={stockLocationId}
                  onChange={(e) => setStockLocationId(e.target.value)}
                  className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
                >
                  <option value="">—</option>
                  {lookups?.stockLocations.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.code})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-sh-gray mb-1">
                  Buy (optional)
                </label>
                <select
                  value={buyId}
                  onChange={(e) => setBuyId(e.target.value)}
                  className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
                >
                  <option value="">— Unassigned —</option>
                  {lookups?.buys.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name} {b.year ? `(${b.year})` : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-sh-gray mb-1">
                  Department (all items)
                </label>
                <select
                  value={departmentId}
                  onChange={(e) => {
                    setDepartmentId(e.target.value);
                    setCategoryId("");
                  }}
                  className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm"
                >
                  <option value="">—</option>
                  {lookups?.departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-sh-gray mb-1">
                  Category (all items)
                </label>
                <select
                  value={categoryId}
                  onChange={(e) => setCategoryId(e.target.value)}
                  disabled={!departmentId}
                  className="w-full border border-sh-gray/30 rounded px-3 py-2 text-sm disabled:opacity-50"
                >
                  <option value="">—</option>
                  {categoriesForDepartment.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-end">
                <label className="inline-flex items-center gap-2 text-sm text-sh-black">
                  <input
                    type="checkbox"
                    checked={stockProgram}
                    onChange={(e) => setStockProgram(e.target.checked)}
                    className="h-4 w-4"
                  />
                  Stock program
                </label>
              </div>
            </div>
          </div>

          <div className="bg-white border border-sh-gray/20 rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[900px]">
                <thead>
                  <tr className="bg-sh-blue text-white text-left">
                    <th className="px-3 py-2">Part #</th>
                    <th className="px-3 py-2">Product</th>
                    <th className="px-3 py-2">Color</th>
                    <th className="px-3 py-2">Size</th>
                    <th className="px-3 py-2 text-right">Qty</th>
                    <th className="px-3 py-2 text-right">Cost</th>
                    <th className="px-3 py-2 text-right">MSRP</th>
                    <th className="px-3 py-2 text-right">Selling</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <tr
                      key={`${row.partNumber}-${i}`}
                      className={i % 2 === 0 ? "bg-white" : "bg-sh-stripe"}
                    >
                      <td className="px-3 py-1.5">
                        <input
                          value={row.partNumber}
                          onChange={(e) => updateRow(i, { partNumber: e.target.value })}
                          className="w-32 border border-sh-gray/30 rounded px-2 py-1 text-xs"
                        />
                      </td>
                      <td className="px-3 py-1.5">
                        <input
                          value={row.productName}
                          onChange={(e) => updateRow(i, { productName: e.target.value })}
                          className="w-40 border border-sh-gray/30 rounded px-2 py-1 text-xs"
                        />
                      </td>
                      <td className="px-3 py-1.5">
                        <input
                          value={row.color}
                          onChange={(e) => updateRow(i, { color: e.target.value })}
                          className="w-28 border border-sh-gray/30 rounded px-2 py-1 text-xs"
                        />
                      </td>
                      <td className="px-3 py-1.5">
                        <input
                          value={row.size}
                          onChange={(e) => updateRow(i, { size: e.target.value })}
                          className="w-16 border border-sh-gray/30 rounded px-2 py-1 text-xs"
                        />
                      </td>
                      <td className="px-3 py-1.5">
                        <input
                          type="number"
                          value={row.qty}
                          onChange={(e) => updateRow(i, { qty: Number(e.target.value) || 0 })}
                          className="w-16 border border-sh-gray/30 rounded px-2 py-1 text-xs text-right"
                        />
                      </td>
                      <td className="px-3 py-1.5">
                        <input
                          type="number"
                          step="0.01"
                          value={row.cost}
                          onChange={(e) => updateRow(i, { cost: Number(e.target.value) || 0 })}
                          className="w-20 border border-sh-gray/30 rounded px-2 py-1 text-xs text-right"
                        />
                      </td>
                      <td className="px-3 py-1.5">
                        <input
                          type="number"
                          step="0.01"
                          value={row.msrp ?? ""}
                          onChange={(e) =>
                            updateRow(i, {
                              msrp: e.target.value === "" ? null : Number(e.target.value),
                            })
                          }
                          className="w-20 border border-sh-gray/30 rounded px-2 py-1 text-xs text-right"
                        />
                      </td>
                      <td className="px-3 py-1.5">
                        <input
                          type="number"
                          step="0.01"
                          value={row.selling ?? ""}
                          onChange={(e) =>
                            updateRow(i, {
                              selling: e.target.value === "" ? null : Number(e.target.value),
                            })
                          }
                          className="w-20 border border-sh-gray/30 rounded px-2 py-1 text-xs text-right"
                        />
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        <button
                          type="button"
                          onClick={() => removeRow(i)}
                          className="text-red-600 text-xs hover:underline"
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-sh-gray/20 bg-sh-linen font-semibold">
                    <td colSpan={4} className="px-3 py-2">
                      {totals.count} row(s)
                    </td>
                    <td className="px-3 py-2 text-right">{totals.qty}</td>
                    <td colSpan={2} className="px-3 py-2 text-right text-sh-gray">
                      Total cost
                    </td>
                    <td className="px-3 py-2 text-right">{formatMoney(totals.cost)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <Button onClick={handleSubmit} disabled={!canSubmit}>
              {submitting ? "Creating..." : "Create Draft PO + Items"}
            </Button>
            {!vendorName.trim() && (
              <span className="text-sm text-red-600">Vendor is required.</span>
            )}
          </div>
        </>
      )}

      {result && (
        <div className="bg-green-50 border border-green-300 rounded-lg p-5 text-sm text-green-800 flex items-center justify-between">
          <div>
            Created draft PO <strong>{result.po.referenceNumber || `#${result.po.id}`}</strong> for{" "}
            <strong>{result.po.vendorName}</strong> with {result.itemCount} item(s).
          </div>
          <Link
            href="/app/admin/buyer-drafts"
            className="px-4 py-2 bg-sh-blue text-white rounded hover:bg-sh-navy transition text-sm font-semibold"
          >
            Open Buyer Drafts
          </Link>
        </div>
      )}
    </div>
  );
}
