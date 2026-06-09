// /app/src/app/(dashboard)/app/admin/import/departments/page.tsx
//
// Import Departments -- App Router port of the legacy admin/import/departments.
// MANAGER / ADMIN (mirrors the legacy withAuth roles). Reads the shared
// /api/departments/import REST endpoint, which stays REST. Chrome from the
// (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { DepartmentImportView } from "./DepartmentImportView";

export default async function DepartmentImportPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <DepartmentImportView />;
}
