// /app/src/app/(dashboard)/app/inventory/reconciled-items/page.tsx
//
// Reconciled Items — App Router port of the legacy inventory/reconciled-items.
// Any signed-in user (legacy bare withAuth, no roles/feature). The view reads
// the ?location= / ?reportType= params via useSearchParams, so it renders inside
// a Suspense boundary. Reads + writes the shared /api/inventory/* REST
// endpoints, which stay REST. Chrome from the (dashboard) layout.

import { Suspense } from "react";
import { requirePage } from "@/lib/auth/requirePage";
import { ReconciledItemsView } from "./ReconciledItemsView";

export default async function ReconciledItemsPage() {
  await requirePage();
  return (
    <Suspense fallback={null}>
      <ReconciledItemsView />
    </Suspense>
  );
}
