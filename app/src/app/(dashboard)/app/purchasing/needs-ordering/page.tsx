// /app/src/app/(dashboard)/app/purchasing/needs-ordering/page.tsx
//
// Needs Ordering -- App Router port. MANAGER / ADMIN / WAREHOUSE (mirrors the
// legacy withAuth roles). Reads the shared /api/purchasing/needs-ordering +
// /api/sales/orders/[id]/create-po REST endpoints, which stay REST.

import { requirePage } from "@/lib/auth/requirePage";
import { NeedsOrderingView } from "./NeedsOrderingView";

export default async function NeedsOrderingPage() {
  await requirePage(["MANAGER", "ADMIN", "WAREHOUSE"]);
  return <NeedsOrderingView />;
}
