// /app/src/app/(dashboard)/app/purchasing/import-order/page.tsx
//
// Import Wholesale Order (CSV or PDF) -- App Router port. MANAGER / ADMIN /
// WAREHOUSE (mirrors the legacy withAuth roles). Reads the shared
// /api/purchasing/import-wholesale-order + /api/purchasing/preview-* +
// /api/purchasing/import-* + /api/departments + /api/categories REST endpoints,
// which stay REST.

import { requirePage } from "@/lib/auth/requirePage";
import { ImportOrderView } from "./ImportOrderView";

export default async function ImportOrderPage() {
  await requirePage(["MANAGER", "ADMIN", "WAREHOUSE"]);
  return <ImportOrderView />;
}
