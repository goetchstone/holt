// /app/src/app/(dashboard)/app/inventory/variance-report/page.tsx
//
// General Variance Report — App Router port of the legacy
// inventory/variance-report. Any signed-in user (legacy bare withAuth, no
// roles/feature). The view reads the ?location= param via useSearchParams, so it
// renders inside a Suspense boundary. Reads the shared /api/inventory/* REST
// endpoints, which stay REST. Chrome from the (dashboard) layout.

import { Suspense } from "react";
import { requirePage } from "@/lib/auth/requirePage";
import { VarianceReportView } from "./VarianceReportView";

export default async function VarianceReportPage() {
  await requirePage();
  return (
    <Suspense fallback={null}>
      <VarianceReportView />
    </Suspense>
  );
}
