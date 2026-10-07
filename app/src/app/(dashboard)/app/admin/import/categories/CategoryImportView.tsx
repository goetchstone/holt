"use client";

// /app/src/app/(dashboard)/app/admin/import/categories/CategoryImportView.tsx
//
// Category CSV import body. App Router port of the legacy
// admin/import/categories body (minus MainLayout chrome, which the (dashboard)
// layout supplies). Parses the CSV client-side, normalizes header aliases, then
// POSTs to the shared /api/categories/import REST endpoint.

import { toast } from "react-toastify";
import axios from "axios";
import CsvImportForm, { type CsvColumnHeader } from "@/components/layout/CsvImportForm";
import { findAliasValue } from "@/lib/csvFieldAlias";
import { getErrorMessage } from "@/lib/toastError";

interface CategoryRow {
  name: string;
  department: string;
  trackInventory?: boolean;
  accountGroup?: string;
  labelTemplateId?: string;
}

const COLUMN_HEADERS: CsvColumnHeader<CategoryRow>[] = [
  { key: "name", label: "Name" },
  { key: "department", label: "Department" },
  { key: "trackInventory", label: "Track Inventory" },
  { key: "accountGroup", label: "Account Group" },
  { key: "labelTemplateId", label: "Label Template ID" },
];

function normalize(rows: Record<string, unknown>[]): CategoryRow[] {
  const normalized = rows
    .map((row) => ({
      name: findAliasValue(row, ["name", "categoryName", "Category Name"]),
      department: findAliasValue(row, ["department", "departmentName", "Department Name"]),
      trackInventory:
        String(row.trackInventory ?? row.TrackInventory ?? "true")
          .toLowerCase()
          .trim() !== "false",
      accountGroup: String(row.accountGroup || row.AccountGroup || "").trim() || undefined,
      labelTemplateId: String(row.labelTemplateId || row.LabelTemplateId || "").trim() || undefined,
    }))
    .filter((row) => row.name && row.department);

  if (normalized.length === 0) {
    toast.warn(
      "No valid data found in the CSV. Ensure rows contain 'name' and 'department' fields.",
    );
  }
  return normalized;
}

async function importCategories(rows: CategoryRow[]): Promise<boolean> {
  try {
    const res = await axios.post("/api/categories/import", { categories: rows });
    toast.success(`Successfully imported. ${res.data?.message || ""}`);
    return true;
  } catch (err: unknown) {
    toast.error(getErrorMessage(err, "Import failed"));
    return false;
  }
}

export function CategoryImportView() {
  return (
    <CsvImportForm<CategoryRow>
      title="Import Categories"
      normalize={normalize}
      columnHeaders={COLUMN_HEADERS}
      onImport={importCategories}
    />
  );
}
