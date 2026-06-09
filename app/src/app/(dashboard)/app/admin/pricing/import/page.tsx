// /app/src/app/(dashboard)/app/admin/pricing/import/page.tsx
//
// Vendor price book import wizard -- App Router port of the legacy
// admin/pricing/import/index. MANAGER / ADMIN (mirrors the legacy withAuth
// roles). Uploads a PDF/CSV/XLSX, previews parsed data, and commits via the
// shared /api/pricing/* REST endpoints, which stay REST. The view reads
// ?vendor= via useSearchParams, so it renders inside a Suspense boundary.
// Chrome from the (dashboard) layout.

import { Suspense } from "react";
import { requirePage } from "@/lib/auth/requirePage";
import { PricingImportView } from "./PricingImportView";

export default async function PricingImportPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return (
    <Suspense fallback={null}>
      <PricingImportView />
    </Suspense>
  );
}
