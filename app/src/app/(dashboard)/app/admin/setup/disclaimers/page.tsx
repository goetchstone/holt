// /app/src/app/(dashboard)/app/admin/setup/disclaimers/page.tsx
//
// Settings -> Disclaimers (GAP-07): the disclaimers staff add to an order, to
// print beside the store-wide footer. Gated on admin.settings, the key
// /api/order-disclaimers writes with. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { DisclaimersView } from "./DisclaimersView";

export default async function DisclaimersPage() {
  await requirePage(undefined, { permission: "admin.settings" });
  return <DisclaimersView />;
}
