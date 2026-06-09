// /app/src/app/(dashboard)/app/admin/automations/customer-ar-drift-check/page.tsx
//
// Customer AR Drift Check -- App Router port of the legacy
// admin/automations/customer-ar-drift-check. MANAGER / ADMIN (mirrors the
// legacy withAuth roles). "Run check" POSTs to the shared
// /api/automations/customer-ar-drift-check REST endpoint, which stays REST.
// Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { CustomerArDriftCheckView } from "./CustomerArDriftCheckView";

export default async function CustomerArDriftCheckPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <CustomerArDriftCheckView />;
}
