// /app/src/app/(dashboard)/app/sales/customers/page.tsx
//
// Customers list — App Router port of the legacy sales/customers/index. Any
// signed-in user (mirrors the legacy withAuth() with no roles). Reads the shared
// /api/customers + /api/customers/recalculate-levels REST endpoints, which stay
// REST. Chrome from the (dashboard) layout. The customer detail route stays in
// Pages Router (/sales/customers/[id]) — no collision with this list path.

import { requirePage } from "@/lib/auth/requirePage";
import { CustomersListView } from "./CustomersListView";

export default async function CustomersListPage() {
  await requirePage();
  return <CustomersListView />;
}
