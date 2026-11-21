// /app/src/app/(dashboard)/app/sales/invoices/page.tsx
//
// Invoices list (authored billing invoices, not POS-imported ones).
// "Bill customers directly" (accounting.invoice), the key of every Invoices
// screen and the billing router; 404 when the billing feature is off.

import { requirePage } from "@/lib/auth/requirePage";
import { requireModule } from "@/lib/modules/requireModule";
import { InvoicesView } from "./InvoicesView";

export default async function InvoicesPage() {
  await requirePage(undefined, { permission: "accounting.invoice" });
  await requireModule("billing");
  return <InvoicesView />;
}
