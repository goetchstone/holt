// /app/src/app/(dashboard)/app/service/house-calls/page.tsx
//
// House calls list -- App Router port. MANAGER / ADMIN / DESIGNER (mirrors the
// legacy withAuth roles list). Reads the shared /api/service/house-calls + staff
// REST endpoints, which stay REST.

import { requirePage } from "@/lib/auth/requirePage";
import { HouseCallsView } from "./HouseCallsView";

export default async function HouseCallsPage() {
  await requirePage(["MANAGER", "ADMIN", "DESIGNER"]);
  return <HouseCallsView />;
}
