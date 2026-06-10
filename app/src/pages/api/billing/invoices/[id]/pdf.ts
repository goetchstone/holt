// /app/src/pages/api/billing/invoices/[id]/pdf.ts
//
// GET — render an authored invoice as a PDF download. REST (not tRPC) because
// the response is binary. MANAGER/ADMIN; 404 when the billing feature is off.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { getAppSettings } from "@/lib/appSettings";
import { isFeatureEnabled } from "@/lib/featureCatalog";
import { getInvoiceDetail } from "@/lib/billing/invoiceService";
import { generateInvoicePdf } from "@/lib/billing/invoicePdf";
import { InvoiceValidationError } from "@/lib/billing/invoiceAuthoring";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }
  const settings = await getAppSettings();
  if (!isFeatureEnabled(settings.features, "billing")) {
    return res.status(404).json({ error: "Not found" });
  }
  const id = Number.parseInt(String(req.query.id), 10);
  if (Number.isNaN(id)) {
    return res.status(400).json({ error: "Invalid invoice id" });
  }
  try {
    const invoice = await getInvoiceDetail(id);
    const money = new Intl.NumberFormat(settings.locale || "en-US", {
      style: "currency",
      currency: settings.currency || "USD",
    });
    const date = new Intl.DateTimeFormat(settings.locale || "en-US", { dateStyle: "long" });
    const pdf = generateInvoicePdf(
      {
        invoiceNo: invoice.invoiceNo,
        invoiceDate: date.format(new Date(invoice.invoiceDate)),
        dueDate: invoice.dueDate ? date.format(new Date(invoice.dueDate)) : null,
        status: invoice.status,
        customerName: invoice.customerName,
        notes: invoice.notes,
        lines: invoice.lines.map((l) => ({
          description: l.description,
          quantity: l.quantity,
          unitPrice: money.format(l.unitPrice),
          amount: money.format(l.amount),
        })),
        subtotal: money.format(invoice.subtotal),
        taxAmount: money.format(invoice.taxAmount),
        total: money.format(invoice.total),
        openBalance: money.format(invoice.openBalance),
      },
      {
        companyName: settings.companyName?.trim() || settings.appName,
        navy: settings.theme.navy,
        gold: settings.theme.gold,
        gray: settings.theme.gray,
      },
    );
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${invoice.invoiceNo}.pdf"`);
    return res.status(200).send(pdf);
  } catch (err) {
    if (err instanceof InvoiceValidationError) {
      return res.status(400).json({ error: err.message });
    }
    logError("Invoice PDF generation failed", err);
    return res.status(500).json({ error: "Failed to generate invoice PDF" });
  }
}

export default requireAuthWithRole(["MANAGER", "ADMIN"], handler);
