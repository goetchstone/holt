// /app/src/app/(dashboard)/app/sales/invoices/[id]/edit/page.tsx
//
// Edit a DRAFT invoice in the shared composer. Server-prefilled so the form
// opens populated; the composer's update mutation re-validates DRAFT status.

import { notFound } from "next/navigation";
import { requirePage } from "@/lib/auth/requirePage";
import { getAppSettings } from "@/lib/appSettings";
import { isFeatureEnabled } from "@/lib/featureCatalog";
import { getInvoiceDetail } from "@/lib/billing/invoiceService";
import { InvoiceComposer } from "../../InvoiceComposer";

export default async function EditInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  await requirePage(["MANAGER", "ADMIN"]);
  const settings = await getAppSettings();
  if (!isFeatureEnabled(settings.features, "billing")) notFound();

  const { id } = await params;
  const invoiceId = Number.parseInt(id, 10);
  if (Number.isNaN(invoiceId)) notFound();

  let invoice;
  try {
    invoice = await getInvoiceDetail(invoiceId);
  } catch {
    notFound();
  }
  if (invoice.status !== "DRAFT") notFound();

  const subtotal = invoice.subtotal;
  return (
    <InvoiceComposer
      initial={{
        id: invoice.id,
        customerId: invoice.customerId ?? 0,
        customerName: invoice.customerName,
        lines: invoice.lines.map((l) => ({
          description: l.description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
        })),
        taxRate: subtotal > 0 ? invoice.taxAmount / subtotal : 0,
        dueDate: invoice.dueDate,
        notes: invoice.notes,
      }}
    />
  );
}
