// /app/src/app/(dashboard)/app/admin/diagnostics/relink-line-items/page.tsx
//
// Relink Order Line Items -- App Router port of the legacy
// admin/diagnostics/relink-line-items. MANAGER / ADMIN (mirrors the legacy
// withAuth roles). Reads + writes the shared /api/admin/relink-line-items REST
// endpoint. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { RelinkLineItemsView } from "./RelinkLineItemsView";

export default async function RelinkLineItemsPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <RelinkLineItemsView />;
}
