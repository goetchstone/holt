// /app/src/app/(dashboard)/app/sales/invoices/page.tsx
//
// Invoices list (authored billing invoices, not POS-imported ones).
// MANAGER/ADMIN; 404 when the billing feature is off.

import { notFound } from "next/navigation";
import { requirePage } from "@/lib/auth/requirePage";
import { getAppSettings } from "@/lib/appSettings";
import { isFeatureEnabled } from "@/lib/featureCatalog";
import { InvoicesView } from "./InvoicesView";

export default async function InvoicesPage() {
  await requirePage(["MANAGER", "ADMIN"]);
  const settings = await getAppSettings();
  if (!isFeatureEnabled(settings.features, "billing")) notFound();
  return <InvoicesView />;
}
