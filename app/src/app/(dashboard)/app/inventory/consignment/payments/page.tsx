// /app/src/app/(dashboard)/app/inventory/consignment/payments/page.tsx
//
// Consignment Payments — App Router port of the legacy
// inventory/consignment/payments. Any signed-in user (mirrors the legacy bare
// withAuth(), no roles/feature). Reads + mutates the shared
// /api/consignment/payments REST endpoints, which stay REST.

import { requirePage } from "@/lib/auth/requirePage";
import { PaymentsView } from "./PaymentsView";

export default async function PaymentsPage() {
  await requirePage();
  return <PaymentsView />;
}
