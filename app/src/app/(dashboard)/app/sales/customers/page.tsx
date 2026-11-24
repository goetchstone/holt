// /app/src/app/(dashboard)/app/sales/customers/page.tsx
//
// Customers list — App Router port of the legacy sales/customers/index. Opens on
// "View orders" (sales.read). Reads the shared /api/customers +
// /api/customers/recalculate-levels REST endpoints, which stay REST. Recalculate
// Levels is offered to holders of "Run marketing" (marketing.write), the key
// that route requires. Chrome from the (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { CustomersListView } from "./CustomersListView";

export default async function CustomersListPage() {
  const { holds } = await requirePage(undefined, {
    permission: "sales.read",
    also: ["marketing.write"],
  });
  return <CustomersListView canRecalculateLevels={holds["marketing.write"]} />;
}
