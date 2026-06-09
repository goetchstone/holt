// /app/src/app/(dashboard)/app/inventory/variance-apparel/page.tsx
//
// Apparel Variance Report — App Router port of the legacy
// inventory/variance-apparel. Any signed-in user (legacy bare withAuth, no
// roles/feature). Location is fixed to "Warehouse" (no query params), so no
// Suspense is needed. Reads the shared /api/inventory/* REST endpoints, which
// stay REST. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { VarianceApparelView } from "./VarianceApparelView";

export default async function VarianceApparelPage() {
  await requirePage();
  return <VarianceApparelView />;
}
