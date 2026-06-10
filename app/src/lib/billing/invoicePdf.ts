// /app/src/lib/billing/invoicePdf.ts
//
// Single-page invoice PDF via jsPDF. Prisma-free and pure — the API route
// resolves the invoice + branding and passes plain data, mirroring
// lib/proposalPdf.ts. Money strings are pre-formatted by the caller so
// currency/locale stay settings-driven.

import { jsPDF } from "jspdf";

export interface InvoicePdfData {
  invoiceNo: string;
  invoiceDate: string;
  dueDate: string | null;
  status: string;
  customerName: string;
  notes: string | null;
  lines: { description: string; quantity: number; unitPrice: string; amount: string }[];
  subtotal: string;
  taxAmount: string;
  total: string;
  openBalance: string;
}

export interface InvoicePdfBranding {
  companyName: string;
  navy: string;
  gold: string;
  gray: string;
}

export const DEFAULT_INVOICE_PDF_BRANDING: InvoicePdfBranding = {
  companyName: "Invoice",
  navy: "#00263E",
  gold: "#A78A5A",
  gray: "#6D6D6D",
};

const PAGE_W = 210;
const MARGIN = 20;
const CONTENT_W = PAGE_W - MARGIN * 2;

export function generateInvoicePdf(
  data: InvoicePdfData,
  branding: InvoicePdfBranding = DEFAULT_INVOICE_PDF_BRANDING,
): Buffer {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  let y = MARGIN;

  doc.setTextColor(branding.navy);
  doc.setFontSize(22);
  doc.setFont("helvetica", "bold");
  doc.text(branding.companyName, MARGIN, y);
  doc.setFontSize(16);
  doc.text("INVOICE", PAGE_W - MARGIN, y, { align: "right" });
  y += 10;

  doc.setDrawColor(branding.gold);
  doc.setLineWidth(0.8);
  doc.line(MARGIN, y, PAGE_W - MARGIN, y);
  y += 10;

  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(branding.gray);
  const meta: string[][] = [
    ["Invoice #", data.invoiceNo],
    ["Date", data.invoiceDate],
    ...(data.dueDate ? [["Due", data.dueDate]] : []),
    ["Status", data.status],
    ["Bill to", data.customerName],
  ];
  for (const [label, value] of meta) {
    doc.setFont("helvetica", "bold");
    doc.text(`${label}:`, MARGIN, y);
    doc.setFont("helvetica", "normal");
    doc.text(value, MARGIN + 28, y);
    y += 6;
  }
  y += 6;

  doc.setFont("helvetica", "bold");
  doc.setTextColor(branding.navy);
  doc.text("Description", MARGIN, y);
  doc.text("Qty", MARGIN + CONTENT_W - 60, y, { align: "right" });
  doc.text("Unit", MARGIN + CONTENT_W - 32, y, { align: "right" });
  doc.text("Amount", MARGIN + CONTENT_W, y, { align: "right" });
  y += 2;
  doc.setDrawColor(branding.navy);
  doc.setLineWidth(0.4);
  doc.line(MARGIN, y, PAGE_W - MARGIN, y);
  y += 6;

  doc.setFont("helvetica", "normal");
  doc.setTextColor(40, 40, 40);
  for (const line of data.lines) {
    const descLines = doc.splitTextToSize(line.description, CONTENT_W - 70) as string[];
    doc.text(descLines, MARGIN, y);
    doc.text(String(line.quantity), MARGIN + CONTENT_W - 60, y, { align: "right" });
    doc.text(line.unitPrice, MARGIN + CONTENT_W - 32, y, { align: "right" });
    doc.text(line.amount, MARGIN + CONTENT_W, y, { align: "right" });
    y += descLines.length * 5 + 3;
    if (y > 250) {
      doc.addPage();
      y = MARGIN;
    }
  }

  y += 4;
  doc.setDrawColor(branding.gray);
  doc.setLineWidth(0.3);
  doc.line(MARGIN + CONTENT_W / 2, y, PAGE_W - MARGIN, y);
  y += 7;

  const totals: Array<[string, string, boolean]> = [
    ["Subtotal", data.subtotal, false],
    ["Tax", data.taxAmount, false],
    ["Total", data.total, true],
    ["Balance due", data.openBalance, true],
  ];
  for (const [label, value, bold] of totals) {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setTextColor(bold ? branding.navy : branding.gray);
    doc.text(label, MARGIN + CONTENT_W - 50, y, { align: "right" });
    doc.text(value, MARGIN + CONTENT_W, y, { align: "right" });
    y += 6;
  }

  if (data.notes) {
    y += 8;
    doc.setFont("helvetica", "bold");
    doc.setTextColor(branding.navy);
    doc.text("Notes", MARGIN, y);
    y += 5;
    doc.setFont("helvetica", "normal");
    doc.setTextColor(branding.gray);
    const noteLines = doc.splitTextToSize(data.notes, CONTENT_W) as string[];
    doc.text(noteLines, MARGIN, y);
  }

  return Buffer.from(doc.output("arraybuffer"));
}
