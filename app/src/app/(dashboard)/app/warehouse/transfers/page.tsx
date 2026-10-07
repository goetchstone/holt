// /app/src/app/(dashboard)/app/warehouse/transfers/page.tsx
//
// Transfers list (inventory transfers between locations) -- App Router port.
// MANAGER / ADMIN / WAREHOUSE (mirrors the legacy withAuth roles). Reads the
// shared /api/warehouse/transfers REST endpoint, which stays REST. Chrome from
// the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { TransfersView } from "./TransfersView";

export default async function TransferListPage() {
  await requirePage(["MANAGER", "ADMIN", "WAREHOUSE"]);
  return <TransfersView />;
}
