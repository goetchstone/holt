// /app/src/app/(dashboard)/app/admin/diagnostics/upcs/page.tsx
//
// UPC / Barcode Viewer -- App Router port of the legacy admin/diagnostics/upcs.
// MANAGER / ADMIN (mirrors the legacy withAuth roles). Reads the shared
// /api/diagnostics/upcs REST endpoint. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { UpcViewerView } from "./UpcViewerView";

export default async function UpcViewerPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <UpcViewerView />;
}
