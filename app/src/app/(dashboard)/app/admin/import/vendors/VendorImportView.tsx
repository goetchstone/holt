"use client";

// /app/src/app/(dashboard)/app/admin/import/vendors/VendorImportView.tsx
//
// Vendor CSV import body. App Router port of the legacy admin/import/vendors body
// (minus MainLayout chrome, which the (dashboard) layout supplies). Parses the
// CSV client-side, normalizes header aliases, then POSTs to the shared
// /api/vendors/import REST endpoint.

import { toast } from "react-toastify";
import axios from "axios";
import CsvImportForm, { type CsvColumnHeader } from "@/components/layout/CsvImportForm";
import { findAliasValue } from "@/lib/csvFieldAlias";
import { getErrorMessage } from "@/lib/toastError";

interface VendorRow {
  name: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  phone?: string;
  email?: string;
}

const COLUMN_HEADERS: CsvColumnHeader<VendorRow>[] = [
  { key: "name", label: "Name" },
  { key: "address", label: "Address" },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
  { key: "zip", label: "ZIP" },
  { key: "phone", label: "Phone" },
  { key: "email", label: "Email" },
];

function normalize(rows: Record<string, unknown>[]): VendorRow[] {
  const normalized = rows
    .map((row) => ({
      name: findAliasValue(row, [
        "name",
        "vendorName",
        "Vendor Name",
        "companyName",
        "Company Name",
      ]),
      address: String(row.address || row.Address || "").trim() || undefined,
      city: String(row.city || row.City || "").trim() || undefined,
      state: String(row.state || row.State || "").trim() || undefined,
      zip: String(row.zip || row.Zip || "").trim() || undefined,
      phone: String(row.phone || row.Phone || "").trim() || undefined,
      email: String(row.email || row.Email || "").trim() || undefined,
    }))
    .filter((row) => row.name);

  if (normalized.length === 0) {
    toast.warn(
      "No valid data found in the CSV. Ensure rows contain a recognized name field (e.g., 'name', 'Name').",
    );
  }
  return normalized;
}

async function importVendors(rows: VendorRow[]): Promise<boolean> {
  try {
    const res = await axios.post("/api/vendors/import", { vendors: rows });
    toast.success(`Successfully imported. ${res.data?.message || ""}`);
    return true;
  } catch (err: unknown) {
    toast.error(getErrorMessage(err, "Import failed"));
    return false;
  }
}

export function VendorImportView() {
  return (
    <CsvImportForm<VendorRow>
      title="Import Vendors"
      normalize={normalize}
      columnHeaders={COLUMN_HEADERS}
      onImport={importVendors}
    />
  );
}
