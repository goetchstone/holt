// /app/src/app/(dashboard)/app/inventory/accurate-scans/page.tsx
//
// Accurate Scans report — App Router port of the legacy inventory/accurate-scans.
// Any signed-in user (legacy bare withAuth, no roles/feature). The view reads
// the ?location= / ?reportType= params via useSearchParams, so it renders inside
// a Suspense boundary. Reads the shared /api/inventory/accurate-scans REST
// endpoint, which stays REST. Chrome from the (dashboard) layout.

import { Suspense } from "react";
import { requirePage } from "@/lib/auth/requirePage";
import { AccurateScansView } from "./AccurateScansView";

export default async function AccurateScansPage() {
  await requirePage();
  return (
    <Suspense fallback={null}>
      <AccurateScansView />
    </Suspense>
  );
}
