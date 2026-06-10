// /app/__tests__/invoicePdf.test.ts
//
// Pure tests for the invoice PDF generator: produces a valid PDF buffer,
// renders every line, and survives long descriptions (pagination path).

import { generateInvoicePdf, DEFAULT_INVOICE_PDF_BRANDING } from "@/lib/billing/invoicePdf";

const baseData = {
  invoiceNo: "INV-260610-001",
  invoiceDate: "June 10, 2026",
  dueDate: "July 1, 2026",
  status: "ISSUED",
  customerName: "Dana Test",
  notes: "Net 21. Thank you for your business.",
  lines: [
    { description: "Consulting - June", quantity: 10, unitPrice: "$150.00", amount: "$1,500.00" },
    { description: "Hosting", quantity: 1, unitPrice: "$100.00", amount: "$100.00" },
  ],
  subtotal: "$1,600.00",
  taxAmount: "$101.60",
  total: "$1,701.60",
  openBalance: "$1,701.60",
};

describe("generateInvoicePdf", () => {
  it("returns a non-trivial PDF buffer", () => {
    const pdf = generateInvoicePdf(baseData, {
      ...DEFAULT_INVOICE_PDF_BRANDING,
      companyName: "Acme Co",
    });
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it("handles a missing due date and missing notes", () => {
    const pdf = generateInvoicePdf({ ...baseData, dueDate: null, notes: null });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("paginates past one page with many long lines", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      description: `Line ${i + 1}: ${"long description text ".repeat(8)}`,
      quantity: 1,
      unitPrice: "$10.00",
      amount: "$10.00",
    }));
    const pdf = generateInvoicePdf({ ...baseData, lines: many });
    // jsPDF writes /Type /Page per page; >1 page means the overflow branch ran.
    const pageCount = pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g)?.length ?? 0;
    expect(pageCount).toBeGreaterThan(1);
  });
});
