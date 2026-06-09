// /app/src/app/(dashboard)/app/inventory/consignment/unpaid-sales/page.tsx
//
// Unpaid Consignment Sales — App Router port of the legacy
// inventory/consignment/unpaid-sales. Any signed-in user (mirrors the legacy
// bare withAuth(), no roles/feature). Reads the shared
// /api/consignment/unpaid-sales REST endpoint, which stays REST.

import { requirePage } from "@/lib/auth/requirePage";
import { UnpaidSalesView } from "./UnpaidSalesView";

export default async function UnpaidSalesPage() {
  await requirePage();
  return <UnpaidSalesView />;
}
