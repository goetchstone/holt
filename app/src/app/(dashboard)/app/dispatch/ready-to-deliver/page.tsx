// /app/src/app/(dashboard)/app/dispatch/ready-to-deliver/page.tsx
//
// Ready to Deliver (in-stock orders grouped by delivery zone) -- App Router port.
// "Operate warehouse" (warehouse.operate), the key of its route and the rest of
// dispatch. Reads the shared /api/dispatch/ready-to-deliver REST endpoint, which
// stays REST.

import { requirePage } from "@/lib/auth/requirePage";
import { ReadyToDeliverView } from "./ReadyToDeliverView";

export default async function ReadyToDeliverPage() {
  await requirePage(undefined, { permission: "warehouse.operate" });
  return <ReadyToDeliverView />;
}
