// /app/src/app/(dashboard)/app/admin/import/vendors/page.tsx
//
// Import Vendors -- App Router port of the legacy admin/import/vendors.
// MANAGER / ADMIN (mirrors the legacy withAuth roles). Reads the shared
// /api/vendors/import REST endpoint, which stays REST. Chrome from the
// (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { VendorImportView } from "./VendorImportView";

export default async function VendorImportPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <VendorImportView />;
}
