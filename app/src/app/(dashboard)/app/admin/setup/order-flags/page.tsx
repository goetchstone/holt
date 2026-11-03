// /app/src/app/(dashboard)/app/admin/setup/order-flags/page.tsx
//
// Settings -> Order flags (GAP-07): the flags staff put on orders, a list the
// store sets up for itself. Gated on admin.settings, the key /api/order-flags
// writes with. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { OrderFlagsView } from "./OrderFlagsView";

export default async function OrderFlagsPage() {
  await requirePage(undefined, { permission: "admin.settings" });
  return <OrderFlagsView />;
}
