// /app/src/app/(dashboard)/app/inventory/consignment/returns-history/page.tsx
//
// Vendor Returns History — App Router port of the legacy
// inventory/consignment/returns-history. Any signed-in user (mirrors the legacy
// bare withAuth(), no roles/feature). Reads the shared
// /api/consignment/vendor-returns REST endpoint, which stays REST.

import { requirePage } from "@/lib/auth/requirePage";
import { ReturnsHistoryView } from "./ReturnsHistoryView";

export default async function ReturnsHistoryPage() {
  await requirePage();
  return <ReturnsHistoryView />;
}
