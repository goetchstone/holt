// /app/src/lib/pricing/kkOrderParser.ts
//
// Server-only parser for K & K Interiors "Order Detail" bundle PDFs
// (OEORD_BUNDLE format). A single PDF holds SEVERAL distinct orders back
// to back, each repeating its own "Order Number:" header on every page.
// Each line item is a fixed block in the pdf-parse text, anchored on the
// unit price + UOM line:
//
//   39.99EA                 <- unit price + UOM, concatenated
//   15668B                  <- vendor item number
//   8/1/26 4                <- required date + required qty
//   0.00                    <- ship qty (not carried on the item)
//   4.00                    <- back-order qty (not carried on the item)
//   13.5 Inch Brown Resin   <- description, 1-4 wrapped lines
//   Horse
//   UPC: 842657186221       <- manufacturer UPC
//   *842657186221*          <- barcode render line (ignored)
//
// Per-order totals print on a "PB#INFO [BUNDORD], ...,[orderNumber],
// [total],..." line that repeats on every page of that order and reads
// [0.00] until the order's last page, where the real total appears -- so
// the last occurrence for a given order number wins.

const pdfParse = require("pdf-parse");

export interface KKOrderItem {
  itemNumber: string;
  description: string;
  uom: string;
  unitPrice: number;
  qty: number;
  requiredDate: string;
  upc: string;
}

export interface KKOrder {
  orderNumber: string;
  requiredDate: string;
  printedTotal: number;
  items: KKOrderItem[];
}

export interface KKOrderBundle {
  vendorName: string;
  customerPo: string;
  orderDate: string;
  orders: KKOrder[];
  warnings: string[];
}

export const KK_VENDOR_NAME = "K & K Interiors";

const PRICE_UOM = /^([\d,]+\.\d{2})([A-Z]{2,4})$/;
const REQUIRED_DATE_QTY = /^(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d+)$/;
const UPC_LINE = /^UPC:\s*(\d+)/;
const ORDER_HEADER = /^Order Number:\s*(\d+)/;
const PB_INFO = /PB#INFO \[BUNDORD\],\s*\[\],\[(\d+)\],\[([\d,.]+)\]/;
const CUSTOMER_PO = /^PON\d+$/;
const ORDER_DATE_LINE = /^Date:\s+(.+)$/;

function parseMoney(raw: string): number {
  return Number.parseFloat(raw.replaceAll(",", ""));
}

interface DescriptionBlock {
  description: string;
  upc: string;
  next: number;
}

/** Reads description lines starting at `start` until a "UPC:" line (consumed,
 *  its digits captured) or the next price+UOM anchor (left for the caller --
 *  yields upc = ""). Never guesses at a UPC that isn't printed. */
function readDescriptionBlock(lines: readonly string[], start: number): DescriptionBlock {
  const descLines: string[] = [];
  let cursor = start;

  while (cursor < lines.length) {
    const line = lines[cursor];
    const upcMatch = UPC_LINE.exec(line);
    if (upcMatch) {
      return { description: descLines.join(" "), upc: upcMatch[1], next: cursor + 1 };
    }
    if (PRICE_UOM.test(line)) break;
    descLines.push(line);
    cursor++;
  }

  return { description: descLines.join(" "), upc: "", next: cursor };
}

interface ItemBlockResult {
  item: KKOrderItem | null;
  next: number;
}

/** Parses one item block anchored at the price+UOM line (index `i`). The
 *  required-date/qty line is the one field the doctrine checks explicitly --
 *  if it doesn't match the expected layout we push a warning naming the item
 *  and skip the block rather than guess at a date or quantity. */
function parseItemBlock(
  lines: readonly string[],
  i: number,
  priceMatch: RegExpExecArray,
  warnings: string[],
): ItemBlockResult {
  const unitPrice = parseMoney(priceMatch[1]);
  const uom = priceMatch[2];
  const itemNumber = lines[i + 1] ?? "";

  const dateQtyMatch = REQUIRED_DATE_QTY.exec(lines[i + 2] ?? "");
  if (!dateQtyMatch) {
    warnings.push(
      `Item ${itemNumber || "(unknown)"}: required date/qty line did not match the expected ` +
        "format -- skipped.",
    );
    return { item: null, next: i + 1 };
  }

  const requiredDate = dateQtyMatch[1];
  const qty = Number.parseInt(dateQtyMatch[2], 10);

  // Ship qty (i+3) and B.O. qty (i+4) are fixed positional filler in the
  // block and aren't part of KKOrderItem -- description starts at i+5.
  const { description, upc, next } = readDescriptionBlock(lines, i + 5);

  return {
    item: { itemNumber, description, uom, unitPrice, qty, requiredDate, upc },
    next,
  };
}

function registerOrder(
  orderNumber: string,
  orderMap: Map<string, KKOrder>,
  orderNumbers: string[],
): void {
  if (orderMap.has(orderNumber)) return;
  orderMap.set(orderNumber, { orderNumber, requiredDate: "", printedTotal: 0, items: [] });
  orderNumbers.push(orderNumber);
}

function recordItem(
  item: KKOrderItem,
  currentOrderNumber: string,
  orderMap: Map<string, KKOrder>,
  warnings: string[],
): void {
  const order = orderMap.get(currentOrderNumber);
  if (!order) {
    warnings.push(`Item ${item.itemNumber}: found before any "Order Number:" header -- skipped.`);
    return;
  }
  if (order.items.length === 0) order.requiredDate = item.requiredDate;
  order.items.push(item);
}

/** Refuse-to-guess reconciliation: compares each order's sum(unitPrice x qty)
 *  against its printed total. Never adjusts a value -- a mismatch is only
 *  ever surfaced as a warning. Orders with no printed total (0 or missing)
 *  are skipped silently, matching the doctrine that we can't check what
 *  wasn't printed. */
function reconcileOrders(orders: KKOrder[], warnings: string[]): void {
  for (const order of orders) {
    if (order.printedTotal <= 0) continue;
    const calculated = order.items.reduce((sum, item) => sum + item.unitPrice * item.qty, 0);
    if (Math.abs(calculated - order.printedTotal) > 0.01) {
      warnings.push(
        `Order ${order.orderNumber}: calculated total ${calculated.toFixed(2)} does not match ` +
          `the printed total ${order.printedTotal.toFixed(2)}.`,
      );
    }
  }
}

/** The document-level fields, which print identically on every page. */
function scanBundleHeader(lines: readonly string[]): { customerPo: string; orderDate: string } {
  let customerPo = "";
  let orderDate = "";
  for (const line of lines) {
    if (!customerPo && CUSTOMER_PO.test(line)) customerPo = line;
    if (!orderDate) {
      const dateMatch = ORDER_DATE_LINE.exec(line);
      if (dateMatch) orderDate = dateMatch[1];
    }
    if (customerPo && orderDate) break;
  }
  return { customerPo, orderDate };
}

interface ScanState {
  orderMap: Map<string, KKOrder>;
  orderNumbers: string[];
  warnings: string[];
  state: { currentOrderNumber: string };
}

/** Consume the line at `index` — an order header, a printed-total line, an
 *  item block, or noise — and return the next index to read. */
function consumeLine(lines: readonly string[], index: number, scan: ScanState): number {
  const line = lines[index];

  const headerMatch = ORDER_HEADER.exec(line);
  if (headerMatch) {
    scan.state.currentOrderNumber = headerMatch[1];
    registerOrder(headerMatch[1], scan.orderMap, scan.orderNumbers);
    return index + 1;
  }

  const pbMatch = PB_INFO.exec(line);
  if (pbMatch) {
    // Last occurrence wins: this line repeats per page at [0.00] until the
    // order's final page, where the real total prints.
    const order = scan.orderMap.get(pbMatch[1]);
    if (order) order.printedTotal = parseMoney(pbMatch[2]);
    return index + 1;
  }

  const priceMatch = PRICE_UOM.exec(line);
  if (priceMatch) {
    const { item, next } = parseItemBlock(lines, index, priceMatch, scan.warnings);
    if (item) recordItem(item, scan.state.currentOrderNumber, scan.orderMap, scan.warnings);
    return next;
  }

  return index + 1;
}

export function parseKKOrderText(text: string): KKOrderBundle {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const warnings: string[] = [];
  const { customerPo, orderDate } = scanBundleHeader(lines);
  const orderNumbers: string[] = [];
  const orderMap = new Map<string, KKOrder>();
  const state = { currentOrderNumber: "" };

  let i = 0;
  while (i < lines.length) {
    i = consumeLine(lines, i, { orderMap, orderNumbers, warnings, state });
  }

  const orders: KKOrder[] = [];
  for (const orderNumber of orderNumbers) {
    const order = orderMap.get(orderNumber);
    if (order) orders.push(order);
  }
  reconcileOrders(orders, warnings);

  return { vendorName: "", customerPo, orderDate, orders, warnings };
}

export async function parseKKOrderPDF(buffer: Buffer): Promise<KKOrderBundle> {
  const data = await pdfParse(buffer);
  return parseKKOrderText(data.text);
}
