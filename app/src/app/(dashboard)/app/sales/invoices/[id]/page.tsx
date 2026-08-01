// /app/src/app/(dashboard)/app/sales/invoices/[id]/page.tsx
//
// Invoice detail + lifecycle actions. MANAGER/ADMIN; 404 when billing is off.

import { notFound } from "next/navigation";
import { requirePage } from "@/lib/auth/requirePage";
import { requireModule } from "@/lib/modules/requireModule";
import { InvoiceDetailView } from "./InvoiceDetailView";

export default async function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePage(["MANAGER", "ADMIN"]);
  await requireModule("billing");

  const { id } = await params;
  const invoiceId = Number.parseInt(id, 10);
  if (Number.isNaN(invoiceId)) notFound();
  return <InvoiceDetailView invoiceId={invoiceId} />;
}
