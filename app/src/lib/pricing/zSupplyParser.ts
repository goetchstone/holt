// /app/src/lib/pricing/zSupplyParser.ts
//
// Server-only parser for Z Supply invoice PDFs. Extracts order metadata
// and line items with size and color details. pdf-parse extracts the text
// with style/color/description concatenated (no spaces), followed by the
// size grid header, then a line with qty + prices.

const pdfParse = require("pdf-parse");

export interface ZSupplyLineItem {
  styleNumber: string;
  colorCode: string;
  productName: string;
  size: string;
  quantity: number;
  unitPrice: number;
  extendedAmount: number;
}

export interface ZSupplyInvoice {
  vendorName: string;
  invoiceNumber: string;
  orderNumber: string;
  poNumber: string;
  invoiceDate: string;
  dueDate: string;
  terms: string;
  shipVia: string;
  trackingNumber: string;
  totalUnits: number;
  totalPrice: number;
  items: ZSupplyLineItem[];
}

function parseNumber(s: string): number {
  if (!s) return 0;
  const cleaned = s.replace(/[,$\s]/g, "");
  const n = Number.parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

// Pack codes: each letter in the size grid represents a pre-assorted pack
// of sizes. The pack quantity on the invoice is multiplied by each size's
// count to get the total units per size.
const PACK_DEFINITIONS: Record<string, { size: string; qty: number }[]> = {
  B: [
    { size: "XS", qty: 1 },
    { size: "S", qty: 2 },
    { size: "M", qty: 2 },
    { size: "L", qty: 1 },
  ],
  // Additional pack codes will be added as Z Supply provides them
};

export async function parseZSupplyPDF(buffer: Buffer): Promise<ZSupplyInvoice> {
  const data = await pdfParse(buffer);
  const text: string = data.text;
  const lines: string[] = text
    .split("\n")
    .map((l: string) => l.trim())
    .filter(Boolean);

  // Extract invoice metadata
  let invoiceNumber = "";
  let invoiceDate = "";
  let dueDate = "";
  let orderNumber = "";
  let poNumber = "";
  let terms = "";
  let shipVia = "";
  let trackingNumber = "";

  // Invoice number appears alone on a line after header labels
  // The text has "3380684" on its own line near the top
  for (const line of lines) {
    if (/^\d{7}$/.test(line) && !invoiceNumber) {
      invoiceNumber = line;
      break;
    }
  }

  // Dates appear as MM/DD/YY on their own lines after the invoice number
  const datePattern = /^\d{2}\/\d{2}\/\d{2}$/;
  const dates: string[] = [];
  for (const line of lines) {
    if (datePattern.test(line)) {
      dates.push(line);
    }
  }
  if (dates.length >= 1) invoiceDate = dates[0];
  if (dates.length >= 2) dueDate = dates[1];

  // Order number: 7-digit number that appears after the dates section
  // It follows the phone/fax line. In the text: "3207417126563-260510Net 30Fed Ex Ground"
  // This is concatenated: orderNumber + poNumber + terms + shipVia
  for (const line of lines) {
    const orderLineMatch = line.match(/^(\d{7})([\d-]+)(Net\s*\d+|COD|Prepaid)(.*?)$/i);
    if (orderLineMatch) {
      orderNumber = orderLineMatch[1];
      poNumber = orderLineMatch[2];
      terms = orderLineMatch[3];
      shipVia = orderLineMatch[4].trim();
      break;
    }
  }

  // Tracking number: long digit string on its own or concatenated
  for (const line of lines) {
    const trackMatch = line.match(/^(\d{12,})/);
    if (trackMatch && trackMatch[1] !== invoiceNumber) {
      trackingNumber = trackMatch[1];
      break;
    }
  }

  // Parse line items
  // In the extracted text, each item appears as:
  //   ZT262714BLNBoa Rib Tank Bellini
  //   A    B    C    D    E    F   XS    S    M    L   XL    G    H    I    J    K    P    N
  //   1  120.00    120.00
  //   .
  //   1
  //
  // Style pattern: 2 letters + 6 digits + 2-3 letter color code + product name (all concatenated)
  const items: ZSupplyLineItem[] = [];
  // Color code is 2-3 uppercase letters. Product name starts with uppercase
  // then lowercase (e.g., "Boa", "The", "Daily"). This distinguishes the
  // color code boundary from the product name in the concatenated text.
  const stylePattern = /^([A-Z]{2}\d{5,6})([A-Z]{2,3})([A-Z][a-z].*)$/;

  for (let i = 0; i < lines.length; i++) {
    const styleMatch = lines[i].match(stylePattern);
    if (!styleMatch) continue;

    const styleNumber = styleMatch[1];
    const colorCode = styleMatch[2];
    const productName = styleMatch[3];

    // Validate this is actually a product line by checking for the size grid header next
    let foundGrid = false;
    for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
      if (/^\s*A\s+B\s+C\s+D/.test(lines[j])) {
        foundGrid = true;
        break;
      }
    }
    if (!foundGrid) continue;

    // Find the price line: "1  120.00    120.00"
    // Pattern: pack count + unit price + extended amount
    let packCount = 0;
    let unitPrice = 0;
    let extendedAmount = 0;

    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      const priceLine = lines[j].match(/^\s*(\d+)\s+([\d,.]+)\s+([\d,.]+)\s*$/);
      if (priceLine) {
        packCount = Number.parseInt(priceLine[1], 10);
        unitPrice = parseNumber(priceLine[2]);
        extendedAmount = parseNumber(priceLine[3]);
        break;
      }
    }

    // Expand pack into individual size entries. Default to pack B since text
    // extraction loses grid column position info. When additional pack codes
    // are provided by Z Supply, add them to PACK_DEFINITIONS above.
    const pack = PACK_DEFINITIONS["B"];

    if (packCount > 0 && pack) {
      const totalPackUnits = pack.reduce((sum, s) => sum + s.qty, 0);
      const pricePerUnit = unitPrice / totalPackUnits;
      for (const sizeEntry of pack) {
        const qty = sizeEntry.qty * packCount;
        items.push({
          styleNumber,
          colorCode,
          productName,
          size: sizeEntry.size,
          quantity: qty,
          unitPrice: pricePerUnit,
          extendedAmount: pricePerUnit * qty,
        });
      }
    } else if (packCount > 0) {
      // Unknown pack code -- import as single item
      items.push({
        styleNumber,
        colorCode,
        productName,
        size: "",
        quantity: packCount,
        unitPrice,
        extendedAmount,
      });
    }
  }

  // Extract totals from footer
  let totalUnits = 0;
  let totalPrice = 0;

  // Look for the total line: "10   1605.00" near the end
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
    const totalMatch = lines[i].match(/^\s*(\d+)\s+([\d,.]+)\s*$/);
    if (totalMatch) {
      totalUnits = Number.parseInt(totalMatch[1], 10);
      totalPrice = parseNumber(totalMatch[2]);
      break;
    }
  }

  // Also check for TOTAL INVOICE line
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 10); i--) {
    if (/^\s*[\d,.]+\s*$/.test(lines[i]) && totalPrice === 0) {
      totalPrice = parseNumber(lines[i]);
    }
  }

  // Fallback: sum from items
  if (totalUnits === 0) {
    totalUnits = items.reduce((sum, item) => sum + item.quantity, 0);
  }
  if (totalPrice === 0) {
    totalPrice = items.reduce((sum, item) => sum + item.extendedAmount, 0);
  }

  return {
    vendorName: "Z Supply",
    invoiceNumber,
    orderNumber,
    poNumber,
    invoiceDate,
    dueDate,
    terms,
    shipVia,
    trackingNumber,
    totalUnits,
    totalPrice,
    items,
  };
}
