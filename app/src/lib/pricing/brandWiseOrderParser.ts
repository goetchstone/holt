// /app/src/lib/pricing/brandWiseOrderParser.ts
//
// Server-only parser for BrandWise "Sales Order" PDFs. Zodax writes orders on
// this platform (owner 2026-07-17), and BrandWise is widely used across
// gift/home vendors, so the platform gets one parser.
//
// An item is a SKU + wrapped description + a money line:
//
//   IN-8222The Cadier Wooden Wall Mirrors  23.75" x     <- SKU + description,
//   35.5"                                                  which wraps
//   4EA200.00800.00                                      <- qty + UOM + price +
//                                                           total, concatenated
//
// or the whole block arrives on one line:
//
//   IN-8432Chevron Wood Box- 13"x 6.5"x 3.25"4EA57.00228.00
//
// Three things this parser gets right, verified against the real order
// (B31669979 / PON09029, 8 items, $3,322.00):
//
// 1. The money line has NO "$" and NO separators — qty + UOM (letters) + unit
//    price + line total, e.g. "4EA200.00800.00". So the price/total boundary is
//    settled by the arithmetic: qty x price == total.
//
// 2. Descriptions carry inch marks ("23.75\" x 35.5\""), so a digit can sit
//    right before the qty. The money tail is anchored at the END of the line
//    and the qty x price == total check confirms the split, rather than
//    trusting a greedy match.
//
// 3. There is NO UPC column — so barcode exports blank and Ordorite assigns its
//    own, which is the owner's intent for vendors that carry no UPC.

const pdfParse = require("pdf-parse");

export interface BrandWiseItem {
  sku: string;
  name: string;
  qty: number;
  uom: string;
  unitPrice: number;
  lineTotal: number;
}

export interface BrandWiseOrder {
  salesOrderNo: string;
  poNumber: string;
  orderDate: string;
  shipDate: string;
  printedTotal: number;
  items: BrandWiseItem[];
  warnings: string[];
}

const SALES_ORDER_NO = /Sales Order No\.?\s*([A-Z0-9]+)/i;
const CUST_PO = /(PON\d+)/;
// The header row prints six values run together on one line; capture the
// order/ship dates by position (label row above, values row below).
const DATE_ROW = /(\d{1,2}\/\d{1,2}\/\d{4})/g;
const TOTAL = /TOTAL IN US\$?:?\s*\$?([\d,]+\.\d{2})/i;

// SKU like "IN-8222". Kept general (letters + dash + digits) so another
// BrandWise vendor's prefix still matches.
const SKU_START = /^([A-Z]+-\d+)/;
// qty + UOM(letters) + unit price + line total, all concatenated, no "$".
const MONEY_LINE = /^(\d+)([A-Za-z]+)([\d,]+\.\d{2})([\d,]+\.\d{2})$/;
// The same money shape anchored at the END of a line (for the concatenated
// single-line form). Non-capturing here — the exact split is redone below.
const MONEY_TAIL = /\d+[A-Za-z]+[\d,]+\.\d{2}[\d,]+\.\d{2}$/;

function parseMoney(raw: string): number {
  return Number.parseFloat(raw.replaceAll(",", ""));
}

/** The rep/platform boilerplate and per-line availability that must never be
 *  read as a name or a price. */
function isFurniture(line: string): boolean {
  return (
    line.startsWith("CUSTOMER OC") ||
    line.startsWith("Sales Order No") ||
    line.startsWith("Order Type") ||
    line.startsWith("Customer ID") ||
    line.startsWith("Printed") ||
    line.startsWith("BILL TO") ||
    line.startsWith("SHIP TO") ||
    line.startsWith("Attn:") ||
    // Available/Incoming are the SUPPLIER's warehouse stock, not this order's
    // fulfillment (owner 2026-07-17), so they are skipped like other furniture.
    line.startsWith("Available Qty") ||
    line.startsWith("Incoming Qty") ||
    line.startsWith("ETA:") ||
    line.startsWith("IMAGE") ||
    line.startsWith("F.O.B") ||
    line.startsWith("ORDER DATE") ||
    line.startsWith("UNIT") ||
    line.startsWith("EXT.") ||
    /^Page:?\s*\d+\s*of\s*\d+/.test(line) ||
    line.startsWith("United States")
  );
}

/** qty x price == total confirms the money split (there is no "$" to lean on). */
function splitMoney(
  qty: number,
  priceTotal: string,
): { unitPrice: number; lineTotal: number } | null {
  const m = /^([\d,]+\.\d{2})([\d,]+\.\d{2})$/.exec(priceTotal);
  if (!m) return null;
  const unitPrice = parseMoney(m[1]);
  const lineTotal = parseMoney(m[2]);
  if (qty <= 0 || Math.abs(unitPrice * qty - lineTotal) > 0.01) return null;
  return { unitPrice, lineTotal };
}

/** A whole item on one concatenated line: SKU + description + qty + UOM + price
 *  + total. The money tail is read from the end and confirmed by arithmetic. */
function tryConcatenatedItem(line: string): BrandWiseItem | null {
  const skuM = SKU_START.exec(line);
  if (!skuM) return null;
  const money = /(\d+)([A-Za-z]+)([\d,]+\.\d{2})([\d,]+\.\d{2})$/.exec(line);
  if (!money || money.index === 0) return null;
  const qty = Number.parseInt(money[1], 10);
  const split = splitMoney(qty, money[3] + money[4]);
  if (!split) return null;
  const sku = skuM[1];
  const name = line.slice(sku.length, money.index).replaceAll(/\s+/g, " ").trim();
  if (!name) return null;
  return { sku, name, qty, uom: money[2], ...split };
}

interface Scan {
  sku: string | null;
  nameLines: string[];
}

function flush(scan: Scan, money: RegExpExecArray, order: BrandWiseOrder): void {
  const qty = Number.parseInt(money[1], 10);
  const split = splitMoney(qty, money[3] + money[4]);
  if (!split) return;
  order.items.push({
    sku: scan.sku as string,
    name: scan.nameLines.join(" ").replaceAll(/\s+/g, " ").trim(),
    qty,
    uom: money[2],
    ...split,
  });
  scan.sku = null;
  scan.nameLines = [];
}

function readSalesOrderNo(order: BrandWiseOrder, line: string): void {
  if (order.salesOrderNo) return;
  const m = SALES_ORDER_NO.exec(line);
  if (m) order.salesOrderNo = m[1];
}

function readPoNumber(order: BrandWiseOrder, line: string): void {
  if (order.poNumber) return;
  const m = CUST_PO.exec(line);
  if (m) order.poNumber = m[1];
}

/** "TOTAL IN US$:" and its value can share a line or split across two. */
function readTotal(order: BrandWiseOrder, rawLines: readonly string[], i: number): void {
  if (order.printedTotal) return;
  const line = rawLines[i];
  const m = TOTAL.exec(line);
  if (m) {
    order.printedTotal = parseMoney(m[1]);
    return;
  }
  if (/^TOTAL IN US\$?:?$/i.test(line)) {
    const next = /^\$?([\d,]+\.\d{2})$/.exec(rawLines[i + 1] ?? "");
    if (next) order.printedTotal = parseMoney(next[1]);
  }
}

/** The values row under "…SHIP VIA BUYER SHIP DATE CANCEL DATE" carries the
 *  ship date first; the Net-terms / order row carries the order date. */
function readShipDate(order: BrandWiseOrder, line: string): void {
  if (order.shipDate || !/FedEx|Ground|Panorama/i.test(line)) return;
  const dates = line.match(DATE_ROW);
  if (dates?.length) order.shipDate = dates[0];
}

function readOrderDate(order: BrandWiseOrder, line: string): void {
  if (order.orderDate || !/Net \d+ Days|Atlanta Showroom/i.test(line)) return;
  const dates = line.match(DATE_ROW);
  if (dates?.length) order.orderDate = dates[0];
}

function readHeader(rawLines: readonly string[], order: BrandWiseOrder): void {
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    readSalesOrderNo(order, line);
    readPoNumber(order, line);
    readTotal(order, rawLines, i);
    readShipDate(order, line);
    readOrderDate(order, line);
  }
}

function readItemLine(line: string, scan: Scan, order: BrandWiseOrder, warnings: string[]): void {
  if (scan.sku !== null) {
    const money = MONEY_LINE.exec(line);
    if (money) {
      flush(scan, money, order);
      return;
    }
    if (!SKU_START.test(line) && !MONEY_TAIL.test(line)) {
      scan.nameLines.push(line);
      return;
    }
    warnings.push(`Item ${scan.sku}: no price line was found before the next item -- skipped.`);
    scan.sku = null;
    scan.nameLines = [];
  }

  const whole = tryConcatenatedItem(line);
  if (whole) {
    order.items.push(whole);
    return;
  }
  const skuM = SKU_START.exec(line);
  if (skuM) {
    scan.sku = skuM[1];
    scan.nameLines = [line.slice(skuM[1].length)];
  }
}

function reconcile(order: BrandWiseOrder): void {
  if (order.printedTotal <= 0) return;
  const calculated = order.items.reduce((sum, i) => sum + i.lineTotal, 0);
  if (Math.abs(calculated - order.printedTotal) > 0.01) {
    order.warnings.push(
      `Line totals sum to ${calculated.toFixed(2)}, which does not match the printed total ` +
        `${order.printedTotal.toFixed(2)}.`,
    );
  }
}

export function parseBrandWiseOrderText(text: string): BrandWiseOrder {
  const warnings: string[] = [];
  const order: BrandWiseOrder = {
    salesOrderNo: "",
    poNumber: "",
    orderDate: "",
    shipDate: "",
    printedTotal: 0,
    items: [],
    warnings,
  };

  const rawLines = text
    .split("\n")
    .map((l) => l.replaceAll(/[\u00a0\u2007\u202f]/gu, " ").trim())
    .filter((l) => l !== "");

  readHeader(rawLines, order);

  const scan: Scan = { sku: null, nameLines: [] };
  for (const line of rawLines) {
    if (isFurniture(line)) continue;
    readItemLine(line, scan, order, warnings);
  }
  if (scan.sku) {
    warnings.push(`Item ${scan.sku}: no price line was found -- skipped.`);
  }

  reconcile(order);
  return order;
}

export async function parseBrandWiseOrderPDF(buffer: Buffer): Promise<BrandWiseOrder> {
  const data = await pdfParse(buffer);
  return parseBrandWiseOrderText(data.text);
}
