// /app/src/app/(dashboard)/app/admin/setup/service/page.tsx
//
// Service Settings -- App Router port of the legacy admin/setup/service.
// MANAGER / ADMIN (mirrors the legacy withAuth roles). Reads the shared
// /api/service/settings/{types,statuses,priorities} REST endpoints. Chrome
// from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { ServiceSetupView } from "./ServiceSetupView";

export default async function ServiceSettingsPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <ServiceSetupView />;
}
