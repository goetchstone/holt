// /app/src/app/(dashboard)/app/admin/setup/tax/load-zips/page.tsx
//
// Load Tax Zip Codes -- App Router port of the legacy admin/setup/tax/load-zips.
// MANAGER / ADMIN (mirrors the legacy withAuth roles). Bulk-loads a state's ZIP
// codes into a tax district via the shared /api/admin/seed-tax-zips REST
// endpoint. Nested under the tax/ route alongside the tax config page. Chrome
// from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { LoadZipsView } from "./LoadZipsView";

export default async function LoadTaxZipsPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <LoadZipsView />;
}
