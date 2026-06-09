// /app/src/app/(dashboard)/app/purchasing/receiving/page.tsx
//
// Receiving Records list -- App Router port. MANAGER / ADMIN / WAREHOUSE
// (mirrors the legacy withAuth roles). Reads the shared /api/purchasing/receiving
// REST endpoint, which stays REST.

import { requirePage } from "@/lib/auth/requirePage";
import { ReceivingListView } from "./ReceivingListView";

export default async function ReceivingListPage() {
  await requirePage(["MANAGER", "ADMIN", "WAREHOUSE"]);
  return <ReceivingListView />;
}
