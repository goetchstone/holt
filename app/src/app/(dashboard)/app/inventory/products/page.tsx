// /app/src/app/(dashboard)/app/inventory/products/page.tsx
//
// All Products list — App Router port of the legacy inventory/products/index.
// Any signed-in user (mirrors the legacy bare withAuth(), no roles/feature).
// Reads the shared /api/products REST endpoint, which stays REST. Chrome from
// the (dashboard) layout. Sits alongside the already-ported products/new hub —
// distinct path, no collision.

import { requirePage } from "@/lib/auth/requirePage";
import { ProductsListView } from "./ProductsListView";

export default async function ProductsPage() {
  await requirePage();
  return <ProductsListView />;
}
