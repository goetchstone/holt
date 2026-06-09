// /app/src/app/(dashboard)/app/admin/import/categories/page.tsx
//
// Import Categories -- App Router port of the legacy admin/import/categories.
// MANAGER / ADMIN (mirrors the legacy withAuth roles). Reads the shared
// /api/categories/import REST endpoint, which stays REST. Chrome from the
// (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { CategoryImportView } from "./CategoryImportView";

export default async function CategoryImportPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <CategoryImportView />;
}
