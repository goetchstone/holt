// /app/src/app/(dashboard)/app/inventory/consignment/page.tsx
//
// Consignment Inventory list — App Router port of the legacy
// inventory/consignment/index. Any signed-in user (mirrors the legacy bare
// withAuth(), no roles/feature). Reads the shared /api/consignment/items REST
// endpoint, which stays REST. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { ConsignmentView } from "./ConsignmentView";

export default async function ConsignmentPage() {
  await requirePage();
  return <ConsignmentView />;
}
