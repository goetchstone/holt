// /app/src/lib/proposalPdf.ts
//
// Generates a polished PDF for a B2B proposal using jsPDF.
// Cover page + one page per item (with image) + summary page.

import { jsPDF } from "jspdf";
import fs from "fs";
import path from "path";
import { safePathJoin, PathTraversalError } from "@/lib/safePathJoin";

interface PdfLineItem {
  itemName: string;
  itemDescription: string | null;
  vendorName: string | null;
  partNumber: string | null;
  retailPrice: number;
  quantity: number;
  selectedGrade: string | null;
  selectedFinish: string | null;
  itemNotes: string | null;
  showInOutput: boolean;
  primaryImagePath: string | null;
}

interface PdfProposal {
  proposalNumber: string;
  projectName: string | null;
  companyName: string | null;
  customerName: string;
  customerAddress: string | null;
  salesPersonName: string | null;
  coverLetter: string | null;
  terms: string | null;
  lineItems: PdfLineItem[];
}

// Brand identity for the generated PDF. Resolved from AppSettings by the API
// route and passed in so this module stays prisma-free and unit-testable.
export interface ProposalPdfBranding {
  name: string;
  navy: string;
  gold: string;
  gray: string;
  linen: string;
}

export const DEFAULT_PROPOSAL_PDF_BRANDING: ProposalPdfBranding = {
  name: "Proposal",
  navy: "#00263E",
  gold: "#A78A5A",
  gray: "#6D6D6D",
  linen: "#F7F5F1",
};

const PAGE_W = 210;
const PAGE_H = 297;
const MARGIN = 20;
const CONTENT_W = PAGE_W - MARGIN * 2;

function currency(v: number): string {
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function loadImageAsBase64(imagePath: string): string | null {
  // imagePath comes from DB (ProposalItemImage.imageUrl) but we still
  // guard against malformed / malicious values that could reach outside
  // the data directory.
  const dataRoot = path.join(process.cwd(), "data");
  let fullPath: string;
  try {
    fullPath = safePathJoin(dataRoot, imagePath);
  } catch (err) {
    if (err instanceof PathTraversalError) return null;
    throw err;
  }
  if (!fs.existsSync(fullPath)) return null;
  const buffer = fs.readFileSync(fullPath);
  const ext = path.extname(fullPath).toLowerCase().replace(".", "");
  const mimeType = ext === "png" ? "PNG" : "JPEG";
  return `data:image/${mimeType};base64,${buffer.toString("base64")}`;
}

export function generateProposalPdf(
  proposal: PdfProposal,
  branding: ProposalPdfBranding = DEFAULT_PROPOSAL_PDF_BRANDING,
): Buffer {
  const NAVY = branding.navy;
  const GOLD = branding.gold;
  const GRAY = branding.gray;
  const LINEN = branding.linen;
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const visibleItems = proposal.lineItems.filter((li) => li.showInOutput);
  const today = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  // --- Cover Page ---
  doc.setFillColor(NAVY);
  doc.rect(0, 0, PAGE_W, 80, "F");

  doc.setTextColor("#FFFFFF");
  doc.setFontSize(28);
  doc.text(branding.name, MARGIN, 35);
  doc.setFontSize(12);
  doc.text("Proposal", MARGIN, 48);

  doc.setFontSize(10);
  doc.text(proposal.proposalNumber, PAGE_W - MARGIN, 35, { align: "right" });
  doc.text(today, PAGE_W - MARGIN, 43, { align: "right" });

  let y = 100;
  doc.setTextColor(NAVY);

  if (proposal.projectName) {
    doc.setFontSize(22);
    doc.text(proposal.projectName, MARGIN, y);
    y += 12;
  }

  if (proposal.companyName) {
    doc.setFontSize(14);
    doc.setTextColor(GOLD);
    doc.text(proposal.companyName, MARGIN, y);
    y += 10;
  }

  doc.setTextColor(GRAY);
  doc.setFontSize(11);
  doc.text(`Prepared for: ${proposal.customerName}`, MARGIN, y);
  y += 7;
  if (proposal.customerAddress) {
    doc.text(proposal.customerAddress, MARGIN, y);
    y += 7;
  }
  if (proposal.salesPersonName) {
    doc.text(`Prepared by: ${proposal.salesPersonName}`, MARGIN, y);
    y += 7;
  }

  if (proposal.coverLetter) {
    y += 10;
    doc.setTextColor(NAVY);
    doc.setFontSize(10);
    const lines = doc.splitTextToSize(proposal.coverLetter, CONTENT_W);
    doc.text(lines, MARGIN, y);
  }

  // --- Item Pages ---
  for (const item of visibleItems) {
    doc.addPage();
    let iy = MARGIN;

    // Gold accent line at top
    doc.setDrawColor(GOLD);
    doc.setLineWidth(0.8);
    doc.line(MARGIN, iy, PAGE_W - MARGIN, iy);
    iy += 10;

    // Item image
    if (item.primaryImagePath) {
      const imgData = loadImageAsBase64(item.primaryImagePath);
      if (imgData) {
        const imgW = CONTENT_W;
        const imgH = 100;
        doc.addImage(imgData, "JPEG", MARGIN, iy, imgW, imgH, undefined, "MEDIUM");
        iy += imgH + 10;
      }
    }

    // Item name
    doc.setTextColor(NAVY);
    doc.setFontSize(18);
    doc.text(item.itemName, MARGIN, iy);
    iy += 8;

    // Vendor and part number
    doc.setFontSize(10);
    doc.setTextColor(GRAY);
    const subline = [item.vendorName, item.partNumber].filter(Boolean).join(" | ");
    if (subline) {
      doc.text(subline, MARGIN, iy);
      iy += 6;
    }

    // Configuration
    const configParts = [
      item.selectedGrade ? `Grade: ${item.selectedGrade}` : null,
      item.selectedFinish ? `Finish: ${item.selectedFinish}` : null,
    ].filter(Boolean);
    if (configParts.length > 0) {
      doc.text(configParts.join("  |  "), MARGIN, iy);
      iy += 6;
    }

    // Description
    if (item.itemDescription) {
      iy += 4;
      doc.setTextColor(NAVY);
      const descLines = doc.splitTextToSize(item.itemDescription, CONTENT_W);
      doc.text(descLines, MARGIN, iy);
      iy += descLines.length * 5 + 4;
    }

    // Price block
    iy += 6;
    doc.setFillColor(LINEN);
    doc.rect(MARGIN, iy - 4, CONTENT_W, 14, "F");
    doc.setTextColor(NAVY);
    doc.setFontSize(14);
    const priceText =
      item.quantity > 1
        ? `${currency(item.retailPrice)} each  x  ${item.quantity}  =  ${currency(item.retailPrice * item.quantity)}`
        : currency(item.retailPrice);
    doc.text(priceText, PAGE_W - MARGIN, iy + 4, { align: "right" });

    // Item notes
    if (item.itemNotes) {
      iy += 20;
      doc.setTextColor(GRAY);
      doc.setFontSize(9);
      const noteLines = doc.splitTextToSize(item.itemNotes, CONTENT_W);
      doc.text(noteLines, MARGIN, iy);
    }
  }

  // --- Summary Page ---
  doc.addPage();
  let sy = MARGIN;

  doc.setDrawColor(GOLD);
  doc.setLineWidth(0.8);
  doc.line(MARGIN, sy, PAGE_W - MARGIN, sy);
  sy += 10;

  doc.setTextColor(NAVY);
  doc.setFontSize(16);
  doc.text("Summary", MARGIN, sy);
  sy += 10;

  // Table header
  doc.setFillColor(NAVY);
  doc.rect(MARGIN, sy, CONTENT_W, 8, "F");
  doc.setTextColor("#FFFFFF");
  doc.setFontSize(9);
  doc.text("Item", MARGIN + 3, sy + 5.5);
  doc.text("Qty", 140, sy + 5.5, { align: "right" });
  doc.text("Price", 165, sy + 5.5, { align: "right" });
  doc.text("Total", PAGE_W - MARGIN - 3, sy + 5.5, { align: "right" });
  sy += 10;

  let grandTotal = 0;
  doc.setTextColor(NAVY);

  for (let i = 0; i < visibleItems.length; i++) {
    const item = visibleItems[i];
    const lineTotal = item.retailPrice * item.quantity;
    grandTotal += lineTotal;

    if (i % 2 === 1) {
      doc.setFillColor(LINEN);
      doc.rect(MARGIN, sy - 3.5, CONTENT_W, 7, "F");
    }

    doc.setFontSize(9);
    doc.setTextColor(NAVY);
    const name = item.itemName.length > 55 ? item.itemName.substring(0, 55) + "..." : item.itemName;
    doc.text(name, MARGIN + 3, sy);
    doc.text(String(item.quantity), 140, sy, { align: "right" });
    doc.text(currency(item.retailPrice), 165, sy, { align: "right" });
    doc.text(currency(lineTotal), PAGE_W - MARGIN - 3, sy, { align: "right" });
    sy += 7;

    // Page break if needed
    if (sy > PAGE_H - 40) {
      doc.addPage();
      sy = MARGIN + 10;
    }
  }

  // Total
  sy += 4;
  doc.setDrawColor(NAVY);
  doc.setLineWidth(0.5);
  doc.line(130, sy, PAGE_W - MARGIN, sy);
  sy += 8;
  doc.setFontSize(12);
  doc.setTextColor(NAVY);
  doc.text("Total:", 130, sy);
  doc.text(currency(grandTotal), PAGE_W - MARGIN - 3, sy, { align: "right" });

  // Terms
  if (proposal.terms) {
    sy += 20;
    doc.setFontSize(8);
    doc.setTextColor(GRAY);
    doc.text("Terms and Conditions", MARGIN, sy);
    sy += 5;
    const termLines = doc.splitTextToSize(proposal.terms, CONTENT_W);
    doc.text(termLines, MARGIN, sy);
  }

  return Buffer.from(doc.output("arraybuffer"));
}
