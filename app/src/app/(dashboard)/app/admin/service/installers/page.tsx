// /app/src/app/(dashboard)/app/admin/service/installers/page.tsx
//
// Installers -- App Router port of the legacy admin/service/installers.
// MANAGER / ADMIN (mirrors the legacy withAuth roles). Reads + writes the shared
// /api/service/installers REST endpoints. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { InstallersView } from "./InstallersView";

export default async function InstallersPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  return <InstallersView />;
}
