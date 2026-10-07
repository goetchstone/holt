// /app/src/app/(dashboard)/app/sales/invoices/new/page.tsx
//
// New invoice composer. MANAGER/ADMIN; 404 when billing is off.

import { requirePage } from "@/lib/auth/requirePage";
import { requireModule } from "@/lib/modules/requireModule";
import { InvoiceComposer } from "../InvoiceComposer";

export default async function NewInvoicePage() {
  await requirePage(["MANAGER", "ADMIN"]);
  await requireModule("billing");
  return <InvoiceComposer />;
}
