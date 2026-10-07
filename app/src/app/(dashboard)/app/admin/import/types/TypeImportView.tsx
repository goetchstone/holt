"use client";

// /app/src/app/(dashboard)/app/admin/import/types/TypeImportView.tsx
//
// Product Type CSV import body. App Router port of the legacy
// admin/import/types body (minus MainLayout chrome, which the (dashboard) layout
// supplies). Parses the CSV client-side, normalizes header aliases, then POSTs
// to the shared /api/types/import REST endpoint.

import { toast } from "react-toastify";
import axios from "axios";
import CsvImportForm, { type CsvColumnHeader } from "@/components/layout/CsvImportForm";
import { findAliasValue } from "@/lib/csvFieldAlias";
import { getErrorMessage } from "@/lib/toastError";

interface TypeRow {
  name: string;
  category: string;
  description?: string;
}

const COLUMN_HEADERS: CsvColumnHeader<TypeRow>[] = [
  { key: "name", label: "Name" },
  { key: "category", label: "Category" },
  { key: "description", label: "Description" },
];

function normalize(rows: Record<string, unknown>[]): TypeRow[] {
  const normalized = rows
    .map((row) => ({
      name: findAliasValue(row, ["name", "typeName", "Type Name"]),
      category: findAliasValue(row, ["category", "categoryName", "Category Name"]),
      description: String(row.description || row.Description || "").trim() || undefined,
    }))
    .filter((row) => row.name && row.category);

  if (normalized.length === 0) {
    toast.warn("No valid data found in the CSV. Ensure rows contain 'name' and 'category' fields.");
  }
  return normalized;
}

async function importTypes(rows: TypeRow[]): Promise<boolean> {
  try {
    const res = await axios.post("/api/types/import", { types: rows });
    toast.success(`Successfully imported. ${res.data?.message || ""}`);
    return true;
  } catch (err: unknown) {
    toast.error(getErrorMessage(err, "Import failed"));
    return false;
  }
}

export function TypeImportView() {
  return (
    <CsvImportForm<TypeRow>
      title="Import Product Types"
      normalize={normalize}
      columnHeaders={COLUMN_HEADERS}
      onImport={importTypes}
    />
  );
}
