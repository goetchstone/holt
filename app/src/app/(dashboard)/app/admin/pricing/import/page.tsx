// /app/src/app/(dashboard)/app/admin/pricing/import/page.tsx
//
// Vendor price book import wizard -- App Router port of the legacy
// admin/pricing/import/index. Gated on `catalog.pricing` -- the same permission
// the /api/pricing/* routes it posts to already require, so DATA_ENTRY (whose job
// is loading price lists) reaches it, not just ADMIN. Uploads a PDF/CSV/XLSX,
// previews parsed data, and commits via the
// shared /api/pricing/* REST endpoints, which stay REST. The view reads
// ?vendor= via useSearchParams, so it renders inside a Suspense boundary.
// Chrome from the (dashboard) layout.

import { Suspense } from "react";
import { requirePage } from "@/lib/auth/requirePage";
import { PricingImportView } from "./PricingImportView";

export default async function PricingImportPage() {
  await requirePage(undefined, { permission: "catalog.pricing" });
  return (
    <Suspense fallback={null}>
      <PricingImportView />
    </Suspense>
  );
}
