// /app/src/app/(dashboard)/app/admin/setup/printers/page.tsx
//
// Printers -- App Router port of the legacy admin/setup/printers/index. Any
// signed-in user (mirrors the legacy bare withAuth(), no roles/feature). Reads
// the shared /api/printers REST endpoint. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { PrintersView } from "./PrintersView";

export default async function PrintersPage() {
  await requirePage();
  return <PrintersView />;
}
