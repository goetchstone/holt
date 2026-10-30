// /app/src/lib/purchasing/purchaseOrderPdf.ts
//
// GAP-01: a purchase order as the vendor reads it -- the store's name and
// colours, who it's from and where it ships, and the lines. jsPDF, Prisma-free
// and pure, like lib/billing/invoicePdf.ts: the caller resolves the PO and the
// branding (lib/purchasing/purchaseOrderDocument.ts) and passes plain data with
// money and dates already formatted, so currency and locale stay settings-driven.
//
// Cost is optional: a PO printed by someone without "View cost" carries the
// quantities and no prices (lib/auth/costVisibility.ts: strip, never deny).

import { jsPDF } from "jspdf";

export interface PurchaseOrderPdfParty {
  name: string;
  /** Address, phone, account number: one printed line each. */
  lines: string[];
}

export interface PurchaseOrderPdfData {
  poNumber: string;
  orderDate: string;
  expectedDelivery: string | null;
  vendor: PurchaseOrderPdfParty;
  shipTo: PurchaseOrderPdfParty | null;
  /** "Payment terms: Net 30" and the like; empty when none are recorded. */
  terms: string[];
  notes: string | null;
  lines: {
    partNo: string;
    description: string;
    quantity: string;
    /** Null when the PO is printed without cost. */
    unitCost: string | null;
    amount: string | null;
  }[];
  /** Null when the PO is printed without cost. */
  total: string | null;
}

export interface PurchaseOrderPdfBranding {
  companyName: string;
  navy: string;
  gold: string;
  gray: string;
}

const PAGE_W = 210;
const PAGE_BOTTOM = 270;
const MARGIN = 20;
const CONTENT_W = PAGE_W - MARGIN * 2;
const COL_QTY = MARGIN + CONTENT_W - 62;
const COL_UNIT = MARGIN + CONTENT_W - 30;
const COL_AMOUNT = MARGIN + CONTENT_W;

function party(
  doc: jsPDF,
  branding: PurchaseOrderPdfBranding,
  heading: string,
  p: PurchaseOrderPdfParty,
  x: number,
  y: number,
): number {
  doc.setFont("helvetica", "bold");
  doc.setTextColor(branding.navy);
  doc.text(heading, x, y);
  y += 5;
  doc.setTextColor(40, 40, 40);
  doc.text(p.name, x, y);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(branding.gray);
  for (const line of p.lines) {
    y += 5;
    doc.text(line, x, y);
  }
  return y;
}

function tableHeader(
  doc: jsPDF,
  branding: PurchaseOrderPdfBranding,
  y: number,
  withCost: boolean,
): number {
  doc.setFont("helvetica", "bold");
  doc.setTextColor(branding.navy);
  doc.text("Part #", MARGIN, y);
  doc.text("Description", MARGIN + 34, y);
  doc.text("Qty", withCost ? COL_QTY : COL_AMOUNT, y, { align: "right" });
  if (withCost) {
    doc.text("Unit cost", COL_UNIT, y, { align: "right" });
    doc.text("Amount", COL_AMOUNT, y, { align: "right" });
  }
  y += 2;
  doc.setDrawColor(branding.navy);
  doc.setLineWidth(0.4);
  doc.line(MARGIN, y, PAGE_W - MARGIN, y);
  return y + 6;
}

function header(
  doc: jsPDF,
  branding: PurchaseOrderPdfBranding,
  data: PurchaseOrderPdfData,
): number {
  let y = MARGIN;
  doc.setTextColor(branding.navy);
  doc.setFontSize(22);
  doc.setFont("helvetica", "bold");
  doc.text(branding.companyName, MARGIN, y);
  doc.setFontSize(16);
  doc.text("PURCHASE ORDER", PAGE_W - MARGIN, y, { align: "right" });
  y += 10;

  doc.setDrawColor(branding.gold);
  doc.setLineWidth(0.8);
  doc.line(MARGIN, y, PAGE_W - MARGIN, y);
  y += 10;

  doc.setFontSize(10);
  const meta: string[][] = [
    ["PO #", data.poNumber],
    ["Date", data.orderDate],
    ...(data.expectedDelivery ? [["Expected", data.expectedDelivery]] : []),
  ];
  for (const [label, value] of meta) {
    doc.setFont("helvetica", "bold");
    doc.setTextColor(branding.gray);
    doc.text(`${label}:`, MARGIN, y);
    doc.setFont("helvetica", "normal");
    doc.text(value, MARGIN + 24, y);
    y += 6;
  }
  y += 4;

  const vendorEnd = party(doc, branding, "Vendor", data.vendor, MARGIN, y);
  const shipEnd = data.shipTo
    ? party(doc, branding, "Ship to", data.shipTo, MARGIN + CONTENT_W / 2, y)
    : y;
  y = Math.max(vendorEnd, shipEnd) + 8;

  if (data.terms.length > 0) {
    doc.setFont("helvetica", "normal");
    doc.setTextColor(branding.gray);
    doc.text(data.terms.join("    "), MARGIN, y);
    y += 8;
  }
  return y;
}

function lineRows(
  doc: jsPDF,
  branding: PurchaseOrderPdfBranding,
  lines: PurchaseOrderPdfData["lines"],
  start: number,
  withCost: boolean,
): number {
  let y = tableHeader(doc, branding, start, withCost);
  doc.setFont("helvetica", "normal");
  const qtyX = withCost ? COL_QTY : COL_AMOUNT;
  const descW = (withCost ? COL_QTY - 14 : COL_AMOUNT - 20) - (MARGIN + 34);
  for (const line of lines) {
    const descLines = doc.splitTextToSize(line.description, descW) as string[];
    if (y + descLines.length * 5 > PAGE_BOTTOM) {
      doc.addPage();
      y = tableHeader(doc, branding, MARGIN, withCost);
      doc.setFont("helvetica", "normal");
    }
    doc.setTextColor(40, 40, 40);
    doc.text(line.partNo, MARGIN, y);
    doc.text(descLines, MARGIN + 34, y);
    doc.text(line.quantity, qtyX, y, { align: "right" });
    if (withCost) {
      doc.text(line.unitCost ?? "", COL_UNIT, y, { align: "right" });
      doc.text(line.amount ?? "", COL_AMOUNT, y, { align: "right" });
    }
    y += descLines.length * 5 + 3;
  }
  return y;
}

/** Start a new page when `needed` more millimetres won't fit below `y`. */
function room(doc: jsPDF, y: number, needed: number): number {
  if (y + needed <= PAGE_BOTTOM) return y;
  doc.addPage();
  return MARGIN;
}

function totalRow(
  doc: jsPDF,
  branding: PurchaseOrderPdfBranding,
  total: string,
  start: number,
): number {
  let y = room(doc, start, 12) + 2;
  doc.setDrawColor(branding.gray);
  doc.setLineWidth(0.3);
  doc.line(MARGIN + CONTENT_W / 2, y, PAGE_W - MARGIN, y);
  y += 7;
  doc.setFont("helvetica", "bold");
  doc.setTextColor(branding.navy);
  doc.text("Total", COL_UNIT, y, { align: "right" });
  doc.text(total, COL_AMOUNT, y, { align: "right" });
  return y + 6;
}

function notesBlock(doc: jsPDF, branding: PurchaseOrderPdfBranding, notes: string, start: number) {
  const noteLines = doc.splitTextToSize(notes, CONTENT_W) as string[];
  let y = room(doc, start, 13 + noteLines.length * 5) + 8;
  doc.setFont("helvetica", "bold");
  doc.setTextColor(branding.navy);
  doc.text("Notes", MARGIN, y);
  y += 5;
  doc.setFont("helvetica", "normal");
  doc.setTextColor(branding.gray);
  doc.text(noteLines, MARGIN, y);
}

export function generatePurchaseOrderPdf(
  data: PurchaseOrderPdfData,
  branding: PurchaseOrderPdfBranding,
): Buffer {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const withCost = data.total !== null;
  let y = header(doc, branding, data);
  y = lineRows(doc, branding, data.lines, y, withCost);
  if (data.total !== null) y = totalRow(doc, branding, data.total, y);
  if (data.notes) notesBlock(doc, branding, data.notes, y);
  return Buffer.from(doc.output("arraybuffer"));
}
