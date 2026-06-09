// /app/src/app/(dashboard)/app/admin/import/types/page.tsx
//
// Import Product Types -- App Router port of the legacy admin/import/types.
// MANAGER / ADMIN (mirrors the legacy withAuth roles). Reads the shared
// /api/types/import REST endpoint, which stays REST. Chrome from the (dashboard)
// layout.

import { requirePage } from "@/lib/auth/requirePage";
import { TypeImportView } from "./TypeImportView";

export default async function TypeImportPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <TypeImportView />;
}
