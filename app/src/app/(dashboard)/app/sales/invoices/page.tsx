// /app/src/app/(dashboard)/app/sales/invoices/page.tsx
//
// Invoices list (authored billing invoices, not POS-imported ones).
// MANAGER/ADMIN; 404 when the billing feature is off.

import { requirePage } from "@/lib/auth/requirePage";
import { requireModule } from "@/lib/modules/requireModule";
import { InvoicesView } from "./InvoicesView";

export default async function InvoicesPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  await requireModule("billing");
  return <InvoicesView />;
}
