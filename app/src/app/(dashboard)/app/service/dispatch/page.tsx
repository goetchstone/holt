// /app/src/app/(dashboard)/app/service/dispatch/page.tsx
//
// Service dispatch board -- App Router port. MANAGER / ADMIN / DESIGNER /
// WAREHOUSE (mirrors the legacy withAuth roles list). Reads the shared
// /api/service/dispatch + installers REST endpoints, which stay REST.

import { requirePage } from "@/lib/auth/requirePage";
import { ServiceDispatchView } from "./ServiceDispatchView";

export default async function ServiceDispatchPage() {
  await requirePage(["MANAGER", "ADMIN", "DESIGNER", "WAREHOUSE"]);
  return <ServiceDispatchView />;
}
