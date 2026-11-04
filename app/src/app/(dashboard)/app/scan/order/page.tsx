// /app/src/app/(dashboard)/app/scan/order/page.tsx
//
// Scan what to reorder on a handheld (GAP-19), on the key a PO written at the
// desk takes.

import { requirePage } from "@/lib/auth/requirePage";
import { OrderView } from "./OrderView";

export default async function ScanOrderPage() {
  await requirePage(undefined, { permission: "purchasing.write" });
  return <OrderView />;
}
