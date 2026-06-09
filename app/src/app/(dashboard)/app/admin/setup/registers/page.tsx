// /app/src/app/(dashboard)/app/admin/setup/registers/page.tsx
//
// Registers -- App Router port of the legacy admin/setup/registers.
// MANAGER / ADMIN (mirrors the legacy withAuth roles). Reads the shared
// /api/registers + /api/warehouse/locations REST endpoints. Chrome from the
// (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { RegistersView } from "./RegistersView";

export default async function RegistersPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <RegistersView />;
}
