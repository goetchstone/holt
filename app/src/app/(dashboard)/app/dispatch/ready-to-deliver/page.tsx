// /app/src/app/(dashboard)/app/dispatch/ready-to-deliver/page.tsx
//
// Ready to Deliver (in-stock orders grouped by delivery zone) -- App Router port.
// MANAGER / ADMIN / WAREHOUSE (mirrors the legacy withAuth roles). Reads the
// shared /api/dispatch/ready-to-deliver REST endpoint, which stays REST.

import { requirePage } from "@/lib/auth/requirePage";
import { ReadyToDeliverView } from "./ReadyToDeliverView";

export default async function ReadyToDeliverPage() {
  await requirePage(["MANAGER", "ADMIN", "WAREHOUSE"]);
  return <ReadyToDeliverView />;
}
