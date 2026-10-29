// /app/src/app/(dashboard)/app/admin/setup/payment-types/page.tsx
//
// Settings -> Payment Types: the tenders a store sets up for itself. Gated on
// admin.settings, the key /api/tenders writes with. Chrome from the
// (dashboard) layout.

import { requirePage } from "@/lib/auth/requirePage";
import { PaymentTypesView } from "./PaymentTypesView";

export default async function PaymentTypesPage() {
  await requirePage(undefined, { permission: "admin.settings" });
  return <PaymentTypesView />;
}
