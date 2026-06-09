// /app/src/app/(dashboard)/app/admin/setup/tax/page.tsx
//
// Tax Configuration -- App Router port of the legacy admin/setup/tax index.
// MANAGER / ADMIN (mirrors the legacy withAuth roles). Reads the shared
// /api/tax/{districts,groups,exempt-reasons,rules} REST endpoints. The
// load-zips bulk tool lives at the nested /admin/setup/tax/load-zips route.
// Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { TaxView } from "./TaxView";

export default async function TaxAdminPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <TaxView />;
}
