// /app/__tests__/purchaseOrderPdf.test.ts
//
// GAP-01: the purchase order PDF a vendor receives, read back through a real
// PDF text extractor -- so what is asserted is what the vendor would see, not
// what the generator was asked to draw.

import {
  generatePurchaseOrderPdf,
  type PurchaseOrderPdfData,
} from "@/lib/purchasing/purchaseOrderPdf";
import { extractPdfText } from "@/lib/pricing/pdfUtils";

const branding = {
  companyName: "Linden Row Home",
  navy: "#00263E",
  gold: "#A78A5A",
  gray: "#6D6D6D",
};

const data: PurchaseOrderPdfData = {
  poNumber: "PO-261030-004",
  orderDate: "October 30, 2026",
  expectedDelivery: "November 29, 2026",
  vendor: {
    name: "Fernbrook Upholstery",
    lines: ["12 Mill Lane", "Hickory, NC 28601", "Our account: FB-2207"],
  },
  shipTo: { name: "Linden Row Warehouse", lines: ["400 Depot Street", "Springfield, IL 62701"] },
  terms: ["Payment terms: Net 30", "Freight: FOB Factory"],
  notes: "Deliver to dock door 2.",
  lines: [
    {
      partNo: "FB-SOFA-84",
      description: "Ashby Sofa 84in",
      quantity: "2",
      unitCost: "$812.00",
      amount: "$1,624.00",
    },
    {
      partNo: "FB-CHR-01",
      description: "Ashby Chair",
      quantity: "1.5",
      unitCost: "$400.00",
      amount: "$600.00",
    },
  ],
  total: "$2,224.00",
};

describe("generatePurchaseOrderPdf", () => {
  it("prints the store, the PO, who it's from and where it ships, the lines and the total", async () => {
    const pdf = generatePurchaseOrderPdf(data, branding);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const text = await extractPdfText(pdf);
    for (const expected of [
      "Linden Row Home",
      "PURCHASE ORDER",
      "PO-261030-004",
      "November 29, 2026",
      "Fernbrook Upholstery",
      "Our account: FB-2207",
      "Ship to",
      "Linden Row Warehouse",
      "400 Depot Street",
      "Payment terms: Net 30",
      "FB-SOFA-84",
      "Ashby Sofa 84in",
      "$812.00",
      "$1,624.00",
      "$2,224.00",
      "Deliver to dock door 2.",
    ]) {
      expect(text).toContain(expected);
    }
  });

  it("without cost, prints quantities and no prices", async () => {
    const pdf = generatePurchaseOrderPdf(
      {
        ...data,
        total: null,
        lines: data.lines.map((l) => ({ ...l, unitCost: null, amount: null })),
      },
      branding,
    );
    const text = await extractPdfText(pdf);
    expect(text).toContain("Ashby Sofa 84in");
    expect(text).toContain("1.5");
    expect(text).not.toContain("$");
    expect(text).not.toContain("Unit cost");
    expect(text).not.toContain("Total");
  });

  it("leaves out Ship to and the expected date when the PO has none", async () => {
    const text = await extractPdfText(
      generatePurchaseOrderPdf(
        { ...data, shipTo: null, expectedDelivery: null, terms: [] },
        branding,
      ),
    );
    expect(text).not.toContain("Ship to");
    expect(text).not.toContain("Expected");
    expect(text).not.toContain("Payment terms");
  });

  it("runs onto more pages, repeating the column headings", async () => {
    const many = Array.from({ length: 70 }, (_, i) => ({
      ...data.lines[0],
      partNo: `FB-${i + 1}`,
      description: `Line ${i + 1} ${"long description ".repeat(6)}`,
    }));
    const pdf = generatePurchaseOrderPdf({ ...data, lines: many }, branding);
    const pages = pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g)?.length ?? 0;
    expect(pages).toBeGreaterThan(1);
    const text = await extractPdfText(pdf);
    expect(text.match(/Unit cost/g)?.length).toBe(pages);
    expect(text).toContain("FB-70");
  });
});
