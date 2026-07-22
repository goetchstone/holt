// /app/src/lib/pricing/superCatOrderParser.ts
//
// Server-only parser for SuperCatSolutions order PDFs. Jamie Young writes
// orders on this platform (owner 2026-07-17), and "Powered by
// SuperCatSolutions.com" reps several gift/home brands, so the platform gets
// one parser and the vendor is read from the document.
//
// Every item is a single line: item number + qty + $unit price + $extension +
// description, run together with no separators:
//
//   9BOATLINEG6$285.00$1,710.00January New - Boa Table Lamp
//   ^item#     ^qty ^price   ^ext  ^description
//
// Verified against the real order (Ref 153642-070126-175-1, 20 items,
// Merchandise Subtotal $22,373.00):
//
// 1. The item number ends in letters OR digits and the qty is a bare digit run
//    right after it ("9KAYABLD71CL4$..." -> item 9KAYABLD71CL, qty 4). The two
//    "$" amounts anchor the split, and qty x price == ext confirms it.
// 2. There is NO UPC column, so barcodes export blank and Ordorite assigns them.
// 3. An order-level discount ("Order Discount -$2,237.30") is NOT applied to the
//    printed unit costs -- it is surfaced as a warning so the buyer applies it
//    deliberately (the costs stay editable in the preview).
// 4. A promotional line ("...10%1Receive a 10% discount on orders over $3,500")
//    has no "$price$ext" pair and is skipped, not read as an item.

const pdfParse = require("pdf-parse");

export interface SuperCatItem {
  itemNumber: string;
  name: string;
  qty: number;
  unitPrice: number;
  lineTotal: number;
}

export interface SuperCatOrder {
  vendorName: string;
  orderNumber: string;
  customerPo: string;
  orderDate: string;
  shipDate: string;
  printedSubtotal: number;
  orderDiscount: number;
  items: SuperCatItem[];
  warnings: string[];
}

const PLATFORM = /SuperCatSolutions/i;
const REF_NUMBER = /Ref #:\s*(\S+)/i;
const ORDER_NUMBER = /Order #\s*(\S+)/i;
const CUST_PO = /Cust PO:\s*(\S+)/i;
const ITEM_TABLE_HEADER = /^Item #.*Description$/i;
const MERCH_SUBTOTAL = /Merchandise Subtotal\s*\$([\d,]+\.\d{2})/i;
const ORDER_DISCOUNT = /Order Discount\s*-?\$([\d,]+\.\d{2})/i;
const DATE_TOKEN = /\d{1,2}\/\d{1,2}\/\d{2,4}/g;

// item number + qty + $unit price + $extension + description.
const ITEM_LINE = /^(.+?)(\d+)\$([\d,]+\.\d{2})\$([\d,]+\.\d{2})(.*)$/;

function parseMoney(raw: string): number {
  return Number.parseFloat(raw.replaceAll(",", ""));
}

function readHeader(rawLines: readonly string[], order: SuperCatOrder): void {
  const tableStart = rawLines.findIndex((l) => ITEM_TABLE_HEADER.test(l));
  const headerLines = tableStart >= 0 ? rawLines.slice(0, tableStart) : rawLines;

  for (let i = 0; i < headerLines.length; i++) {
    const line = headerLines[i];
    if (!order.vendorName && PLATFORM.test(line)) {
      // The company name is the first line after the platform banner.
      order.vendorName = (headerLines[i + 1] ?? "").trim();
    }
    if (!order.orderNumber) {
      const m = REF_NUMBER.exec(line) ?? ORDER_NUMBER.exec(line);
      if (m) order.orderNumber = m[1];
    }
    if (!order.customerPo) {
      const m = CUST_PO.exec(line);
      if (m) order.customerPo = m[1];
    }
  }

  // The header prints Submit Date and Ship Date as bare values in a block whose
  // labels sit above it; identify them by type. The first date is the
  // order/submit date, a later distinct date is the ship date.
  const dates = headerLines.join("\n").match(DATE_TOKEN) ?? [];
  order.orderDate = dates[0] ?? "";
  order.shipDate = dates.find((d) => d !== order.orderDate) ?? "";
}

function readItems(rawLines: readonly string[], order: SuperCatOrder): void {
  for (const line of rawLines) {
    const m = ITEM_LINE.exec(line);
    if (!m) continue;
    const itemNumber = m[1].trim();
    const qty = Number.parseInt(m[2], 10);
    const unitPrice = parseMoney(m[3]);
    const lineTotal = parseMoney(m[4]);
    const name = m[5].trim();
    if (!itemNumber || !name) continue;
    if (qty <= 0 || Math.abs(unitPrice * qty - lineTotal) > 0.01) {
      order.warnings.push(
        `Item ${itemNumber}: ${qty} x ${unitPrice.toFixed(2)} does not equal the line total ` +
          `${lineTotal.toFixed(2)} — check it before importing.`,
      );
      continue;
    }
    order.items.push({ itemNumber, name, qty, unitPrice, lineTotal });
  }
}

function reconcile(order: SuperCatOrder): void {
  if (order.printedSubtotal > 0) {
    const calculated = order.items.reduce((sum, i) => sum + i.lineTotal, 0);
    if (Math.abs(calculated - order.printedSubtotal) > 0.01) {
      order.warnings.push(
        `Line totals sum to ${calculated.toFixed(2)}, which does not match the merchandise ` +
          `subtotal ${order.printedSubtotal.toFixed(2)}.`,
      );
    }
  }
  if (order.orderDiscount > 0) {
    order.warnings.push(
      `This order has an order-level discount of ${order.orderDiscount.toFixed(2)} that is NOT ` +
        "reflected in the unit costs shown — apply it to the costs before importing if the PO " +
        "should carry the discounted price.",
    );
  }
}

export function parseSuperCatOrderText(text: string): SuperCatOrder {
  const warnings: string[] = [];
  const order: SuperCatOrder = {
    vendorName: "",
    orderNumber: "",
    customerPo: "",
    orderDate: "",
    shipDate: "",
    printedSubtotal: 0,
    orderDiscount: 0,
    items: [],
    warnings,
  };

  const rawLines = text
    .split("\n")
    .map((l) => l.replaceAll(/[\u00a0\u2007\u202f]/gu, " ").trim())
    .filter((l) => l !== "");

  readHeader(rawLines, order);

  for (const line of rawLines) {
    const sub = MERCH_SUBTOTAL.exec(line);
    if (sub) order.printedSubtotal = parseMoney(sub[1]);
    const disc = ORDER_DISCOUNT.exec(line);
    if (disc) order.orderDiscount = parseMoney(disc[1]);
  }

  readItems(rawLines, order);
  reconcile(order);
  return order;
}

export async function parseSuperCatOrderPDF(buffer: Buffer): Promise<SuperCatOrder> {
  const data = await pdfParse(buffer);
  return parseSuperCatOrderText(data.text);
}
