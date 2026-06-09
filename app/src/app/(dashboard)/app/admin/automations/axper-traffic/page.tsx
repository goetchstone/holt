// /app/src/app/(dashboard)/app/admin/automations/axper-traffic/page.tsx
//
// Axper Traffic Sync -- App Router port of the legacy
// admin/automations/axper-traffic. MANAGER / ADMIN / SUPER_ADMIN (mirrors the
// legacy withAuth roles). "Run Now" POSTs to the shared
// /api/automations/axper-traffic-sync REST endpoint, which stays REST. Chrome
// from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { AxperTrafficView } from "./AxperTrafficView";

export default async function AxperTrafficPage() {
  await requirePage(["MANAGER", "ADMIN", "SUPER_ADMIN"]);
  return <AxperTrafficView />;
}
