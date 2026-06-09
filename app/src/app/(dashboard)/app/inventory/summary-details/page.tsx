// /app/src/app/(dashboard)/app/inventory/summary-details/page.tsx
//
// Inventory Summary Details — App Router port of the legacy
// inventory/summary-details. Any signed-in user (legacy bare withAuth, no
// roles/feature). The view reads ?groupType= / ?groupName= via useSearchParams,
// so it renders inside a Suspense boundary. Reads the shared
// /api/inventory/summary-details REST endpoint, which stays REST. Chrome from
// the (dashboard) layout.

import { Suspense } from "react";
import { requirePage } from "@/lib/auth/requirePage";
import { SummaryDetailsView } from "./SummaryDetailsView";

export default async function SummaryDetailsPage() {
  await requirePage();
  return (
    <Suspense fallback={null}>
      <SummaryDetailsView />
    </Suspense>
  );
}
