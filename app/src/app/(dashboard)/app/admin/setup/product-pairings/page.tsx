// /app/src/app/(dashboard)/app/admin/setup/product-pairings/page.tsx
//
// Product Pairings -- App Router port of the legacy admin/setup/product-pairings.
// ADMIN / MARKETING (mirrors the legacy withAuth roles). Reads the shared
// /api/admin/product-pairings + /api/departments + /api/categories REST
// endpoints. Drives the Missing Pieces tile on the Opportunities hub. Chrome
// from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { ProductPairingsView } from "./ProductPairingsView";

export default async function ProductPairingsPage() {
  await requirePage(["ADMIN", "MARKETING"]);
  return <ProductPairingsView />;
}
