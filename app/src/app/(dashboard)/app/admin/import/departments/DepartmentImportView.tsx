"use client";

// /app/src/app/(dashboard)/app/admin/import/departments/DepartmentImportView.tsx
//
// Department CSV import body. App Router port of the legacy
// admin/import/departments body (minus MainLayout chrome, which the (dashboard)
// layout supplies). Parses the CSV client-side, normalizes header aliases, then
// POSTs to the shared /api/departments/import REST endpoint.

import { toast } from "react-toastify";
import axios from "axios";
import CsvImportForm, { type CsvColumnHeader } from "@/components/layout/CsvImportForm";
import { findAliasValue } from "@/lib/csvFieldAlias";
import { getErrorMessage } from "@/lib/toastError";

interface DepartmentRow {
  name: string;
}

const COLUMN_HEADERS: CsvColumnHeader<DepartmentRow>[] = [{ key: "name", label: "Name" }];

function normalize(rows: Record<string, unknown>[]): DepartmentRow[] {
  const normalized = rows
    .map((row) => ({ name: findAliasValue(row, ["name", "departmentName", "Department Name"]) }))
    .filter((row) => row.name);

  if (normalized.length === 0) {
    toast.warn(
      "No valid data found in the CSV. Ensure headers match expected fields and rows contain a 'name'.",
    );
  }
  return normalized;
}

async function importDepartments(rows: DepartmentRow[]): Promise<boolean> {
  try {
    const res = await axios.post("/api/departments/import", { departments: rows });
    toast.success(`Successfully imported. ${res.data?.message || ""}`);
    return true;
  } catch (err: unknown) {
    toast.error(getErrorMessage(err, "Import failed"));
    return false;
  }
}

export function DepartmentImportView() {
  return (
    <CsvImportForm<DepartmentRow>
      title="Import Departments"
      normalize={normalize}
      columnHeaders={COLUMN_HEADERS}
      onImport={importDepartments}
    />
  );
}
