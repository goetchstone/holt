// /app/src/app/(dashboard)/app/admin/tools/categorize-products/page.tsx
//
// Categorize Products -- App Router port. MANAGER / ADMIN (mirrors the legacy
// withAuth roles). Reads the shared /api/admin/uncategorized-products +
// /api/admin/bulk-categorize REST endpoints. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { CategorizeProductsView } from "./CategorizeProductsView";

export default async function CategorizeProductsPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <CategorizeProductsView />;
}
