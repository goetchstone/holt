// /app/src/app/(dashboard)/app/admin/import/data/page.tsx
//
// Import Data -- App Router port of the legacy admin/import/data. MANAGER / ADMIN
// (mirrors the legacy withAuth roles). Reads the shared /api/import/generic REST
// endpoint, which stays REST. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { GenericImportView } from "./GenericImportView";

export default async function GenericImportPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <GenericImportView />;
}
