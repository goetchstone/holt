// /app/src/app/(dashboard)/app/warehouse/pickups/page.tsx
//
// Pickup schedule (customer pickups grouped by date) -- App Router port. "Take
// returns" (sales.return), the key of its list and of marking a pickup done.
// "Add to run" also needs "Operate warehouse"; a viewer without it does not get
// the choice. Reads the shared /api/warehouse/returns/pickups +
// /api/returns/[id]/status REST endpoints, which stay REST. Chrome from the
// (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { PickupsView } from "./PickupsView";

export default async function PickupsPage() {
  await requirePage(undefined, { permission: "sales.return" });
  return <PickupsView />;
}
