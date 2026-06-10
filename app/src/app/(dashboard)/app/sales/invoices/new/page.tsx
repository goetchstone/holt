// /app/src/app/(dashboard)/app/sales/invoices/new/page.tsx
//
// New invoice composer. MANAGER/ADMIN; 404 when billing is off.

import { notFound } from "next/navigation";
import { requirePage } from "@/lib/auth/requirePage";
import { getAppSettings } from "@/lib/appSettings";
import { isFeatureEnabled } from "@/lib/featureCatalog";
import { InvoiceComposer } from "../InvoiceComposer";

export default async function NewInvoicePage() {
  await requirePage(["MANAGER", "ADMIN"]);
  const settings = await getAppSettings();
  if (!isFeatureEnabled(settings.features, "billing")) notFound();
  return <InvoiceComposer />;
}
