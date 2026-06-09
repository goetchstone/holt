// /app/src/app/(dashboard)/app/service/house-calls/new/page.tsx
//
// New house call form -- App Router port. MANAGER / ADMIN / DESIGNER (mirrors
// the legacy withAuth roles list). Reads the shared /api/service/house-calls +
// staff + warehouse/locations + customers + sales/orders REST endpoints, which
// stay REST.

import { requirePage } from "@/lib/auth/requirePage";
import { NewHouseCallView } from "./NewHouseCallView";

export default async function NewHouseCallPage() {
  await requirePage(["MANAGER", "ADMIN", "DESIGNER"]);
  return <NewHouseCallView />;
}
