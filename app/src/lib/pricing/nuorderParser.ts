// /app/src/lib/pricing/nuorderParser.ts
//
// Server-only parser for NuORDER wholesale order PDFs. Extracts order
// metadata and line items with per-size breakdowns from the text output
// of pdf-parse. Used for apparel vendor PO imports.

const pdfParse = require("pdf-parse");

export interface NuOrderSize {
  size: string;
  quantity: number;
}

export interface NuOrderLineItem {
  productName: string;
  styleNumber: string;
  msrp: number;
  season: string;
  color: string;
  colorCode: string;
  unitPrice: number;
  totalUnits: number;
  totalPrice: number;
  sizes: NuOrderSize[];
}

export interface NuOrderPO {
  vendorName: string;
  orderNumber: string;
  poNumber: string;
  orderDate: string;
  deliveryStart: string;
  deliveryEnd: string;
  terms: string;
  buyerName: string;
  buyerEmail: string;
  totalUnits: number;
  totalPrice: number;
  items: NuOrderLineItem[];
}

function parseNumber(s: string): number {
  if (!s) return 0;
  const cleaned = s.replace(/[,$\s]/g, "");
  const n = Number.parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

function parseSizes(line: string): NuOrderSize[] {
  const sizes: NuOrderSize[] = [];
  // Matches patterns like "25: 1", "M: 2", "XL: 1"
  const regex = /([A-Z0-9/]+):\s*(\d+)/gi;
  let match;
  while ((match = regex.exec(line)) !== null) {
    sizes.push({ size: match[1], quantity: Number.parseInt(match[2], 10) });
  }
  return sizes;
}

export async function parseNuOrderPDF(buffer: Buffer): Promise<NuOrderPO> {
  const data = await pdfParse(buffer);
  const text: string = data.text;
  const lines: string[] = text
    .split("\n")
    .map((l: string) => l.trim())
    .filter(Boolean);

  // Extract vendor name from the first few lines (usually the brand name)
  // NuORDER puts the brand name prominently -- look for it near the top
  let vendorName = "";
  // The vendor name typically appears after the sales rep info and before Bill to
  // We'll try to extract it from the footer: "Favorite Daughter * New York..."
  const footerMatch = text.match(/^([A-Za-z\s]+)\s*\*\s*[A-Za-z\s]+\d{5}/m);
  if (footerMatch) {
    vendorName = footerMatch[1].trim();
  }

  // Order number and date
  let orderNumber = "";
  let orderDate = "";
  const orderNumMatch = text.match(/Order\s*#?:?\s*([\d-]+)/i);
  if (orderNumMatch) orderNumber = orderNumMatch[1];
  const orderDateMatch = text.match(/Order\s*Date:\s*([A-Z]{3}\s+\d{1,2},\s*\d{4})/i);
  if (orderDateMatch) orderDate = orderDateMatch[1];

  // PO number
  let poNumber = "";
  const poMatch = text.match(/PO\s*#?:?\s*([A-Za-z0-9]+)/i);
  if (poMatch) poNumber = poMatch[1];

  // Delivery dates
  let deliveryStart = "";
  let deliveryEnd = "";
  const deliveryMatch = text.match(
    /Delivery:\s*(\d{2}\/\d{2}\/\d{4})\s*-\s*(\d{2}\/\d{2}\/\d{4})/i,
  );
  if (deliveryMatch) {
    deliveryStart = deliveryMatch[1];
    deliveryEnd = deliveryMatch[2];
  }

  // Terms
  let terms = "";
  const termsMatch = text.match(/Terms:\s*(.+)/i);
  if (termsMatch) terms = termsMatch[1].trim();

  // Buyer info — the retailer placing the order. Set COMPANY_EMAIL_DOMAIN to
  // match the buyer's address (so the vendor's email isn't picked up by
  // mistake); without it, the first email in the proposal is used.
  let buyerName = "";
  let buyerEmail = "";
  const domain = process.env.COMPANY_EMAIL_DOMAIN?.trim();
  const escapedDomain = domain ? domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "";
  const emailPattern = domain
    ? new RegExp(`([\\w.]+@${escapedDomain})`, "i")
    : /([\w.]+@[\w.]+\.\w+)/i;
  const emailMatch = text.match(emailPattern);
  if (emailMatch) buyerEmail = emailMatch[1];
  // Name appears just before the email in the bill-to section
  const nameMatch = text.match(/([A-Z][a-z]+ [A-Z][a-z]+)\n[\w.]+@/);
  if (nameMatch) buyerName = nameMatch[1];

  // Total units and price
  let totalUnits = 0;
  let totalPrice = 0;
  const totalUnitsMatch = text.match(/Total\s*Units:\s*(\d+)/i);
  if (totalUnitsMatch) totalUnits = Number.parseInt(totalUnitsMatch[1], 10);
  const totalPriceMatch = text.match(/Total\s*Price:\s*\$([\d,.]+)/i);
  if (totalPriceMatch) totalPrice = parseNumber(totalPriceMatch[1]);

  // Parse line items
  // Each item block follows this pattern in the text:
  // PRODUCT NAME
  // Style #: XXXXX
  // MSRP: $XXX.XX
  // Season: spring 2026
  // Color: xxx
  // Color Code: XXX
  // $XX.XX  N  $XXX.XX   (unit price, total units, total price)
  // Sizes: 25: 1 26: 1 ...
  const items: NuOrderLineItem[] = [];

  // Find all style # occurrences to anchor item blocks
  const styleRegex = /Style\s*#:\s*([A-Z0-9]+)/gi;
  const styleMatches: { index: number; styleNumber: string }[] = [];
  let styleMatch;
  while ((styleMatch = styleRegex.exec(text)) !== null) {
    styleMatches.push({ index: styleMatch.index, styleNumber: styleMatch[1] });
  }

  for (let i = 0; i < styleMatches.length; i++) {
    const start = styleMatches[i].index;
    const end = i + 1 < styleMatches.length ? styleMatches[i + 1].index : text.length;
    // Forward block: only text belonging to this item (from Style # to next Style #)
    const forwardBlock = text.substring(start, end);

    const styleNumber = styleMatches[i].styleNumber;

    // Product name: appears before "Style #:" -- look back up to 200 chars
    let productName = "";
    const preStyle = text.substring(Math.max(0, start - 200), start);
    const preLines = preStyle
      .split("\n")
      .map((l: string) => l.trim())
      .filter(Boolean);
    for (let j = preLines.length - 1; j >= 0; j--) {
      const line = preLines[j];
      if (/^THE\s+/.test(line) || /^[A-Z\s]{5,}$/.test(line)) {
        productName = line;
        break;
      }
    }

    // All field extraction uses forwardBlock to avoid picking up previous item data
    let msrp = 0;
    const msrpMatch = forwardBlock.match(/MSRP:\s*\$([\d,.]+)/i);
    if (msrpMatch) msrp = parseNumber(msrpMatch[1]);

    let season = "";
    const seasonMatch = forwardBlock.match(/Season:\s*(.+)/i);
    if (seasonMatch) season = seasonMatch[1].trim();

    let color = "";
    const colorMatch = forwardBlock.match(/Color:\s*(.+)/i);
    if (colorMatch) color = colorMatch[1].trim();

    let colorCode = "";
    const colorCodeMatch = forwardBlock.match(/Color\s*Code:\s*(\w+)/i);
    if (colorCodeMatch) colorCode = colorCodeMatch[1];

    // Unit price and totals: "$103.008$824.00" or "$103.00 8 $824.00"
    let unitPrice = 0;
    let itemTotalUnits = 0;
    let itemTotalPrice = 0;
    const priceLineMatch = forwardBlock.match(/\$([\d,.]+)\s*(\d+)\s*\$([\d,.]+)/);
    if (priceLineMatch) {
      unitPrice = parseNumber(priceLineMatch[1]);
      itemTotalUnits = Number.parseInt(priceLineMatch[2], 10);
      itemTotalPrice = parseNumber(priceLineMatch[3]);
    }

    // Sizes -- may be on the same line as "Sizes:" or the next line
    let sizes: NuOrderSize[] = [];
    const sizesMatch = forwardBlock.match(/Sizes:\s*\n?\s*(.+)/i);
    if (sizesMatch) {
      sizes = parseSizes(sizesMatch[1]);
    }

    items.push({
      productName,
      styleNumber,
      msrp,
      season,
      color,
      colorCode,
      unitPrice,
      totalUnits: itemTotalUnits,
      totalPrice: itemTotalPrice,
      sizes,
    });
  }

  return {
    vendorName,
    orderNumber,
    poNumber,
    orderDate,
    deliveryStart,
    deliveryEnd,
    terms,
    buyerName,
    buyerEmail,
    totalUnits,
    totalPrice,
    items,
  };
}
