// /app/src/lib/pricing/beatrizBallOrderParser.ts
//
// Server-only parser for Beatriz Ball "Sales Order" PDFs (owner 2026-07-17).
// The vendor's name is a letterhead image, not text, so it is pinned by the
// registry rather than read from the document; the only text anchor is the
// "DEPT AT 952426 / ATLANTA, GA" remit block.
//
// Each item is a single run-together line:
//
//   349699.0056.0024.754GLASS Vento Medium Vase (Clear)
//   ^code ^amt ^msrp^whsl^qty ^description
//
// Verified against both real orders (SO 0063477 net $226.00; SO 0063476 net
// $2,368.50):
//
// 1. The line packs, with NO separators: item code (digits), line Amount
//    (extended), MSRP, Wholesale UNIT price, qty, description. The item-code /
//    Amount boundary is ambiguous by shape alone ("3496"+"99.00" vs
//    "34969"+"9.00"), so it is settled by arithmetic: Wholesale x qty == Amount.
// 2. Descriptions WRAP — a line may end "(Bordeaux and " with "White)" on the
//    next line; continuation lines are appended until the next item or a header.
// 3. There is NO UPC column, so barcodes export blank and Ordorite assigns them.
// 4. The MSRP column is real, so it prefills the row's MSRP and selling price.
// 5. A free $0 line (a "Beatriz Ball metal placard") reconciles at 0 and is kept.

const pdfParse = require("pdf-parse");

export interface BeatrizBallItem {
  itemCode: string;
  name: string;
  qty: number;
  unitPrice: number;
  lineTotal: number;
  msrp: number;
}

export interface BeatrizBallOrder {
  vendorName: string;
  orderNumber: string;
  customerPo: string;
  orderDate: string;
  printedTotal: number;
  items: BeatrizBallItem[];
  warnings: string[];
}

const PO_NUMBER = /PO #\s*(\S+)/;
const ORDER_NUMBER = /^0\d{6}$/; // e.g. 0063477 (order) — a 7-digit 0-lead code
const ORDER_DATE = /^\d{1,2}\/\d{1,2}\/\d{4}$/;
const NET_ORDER = /Net Order:\s*([\d,]+\.\d{2})/i;

// The three money values + trailing qty, once the item code is split off.
const MONEY_TAIL = /^([\d,]+\.\d{2})([\d,]+\.\d{2})([\d,]+\.\d{2})(\d+)$/;

// Header / footer / boilerplate line starts that must never be read as an item
// or a description continuation (compared case-insensitively at line start).
const BOILERPLATE_PREFIXES = [
  "sales order",
  "dept at",
  "atlanta",
  "(888)",
  "sold to",
  "ship to",
  "saybrook",
  "old saybrook",
  "po #",
  "order number",
  "order date",
  "customer",
  "terms",
  "item code",
  "wholesale",
  "item descrip",
  "ordered",
  "net order",
  "freight",
  "sales tax",
  "order total",
  "continued",
];
const BOILERPLATE_PATTERN = /^(?:\d+ MAIN|I0\d)/i;

/** A header/footer line, or a bare numeric/date line — never an item nor a
 *  description continuation. */
function isBoilerplate(line: string): boolean {
  const lower = line.toLowerCase();
  if (BOILERPLATE_PREFIXES.some((p) => lower.startsWith(p))) return true;
  return BOILERPLATE_PATTERN.test(line) || /^[\d/,.]+$/.test(line);
}

function parseMoney(raw: string): number {
  return Number.parseFloat(raw.replaceAll(",", ""));
}

interface MoneyTail {
  amount: number;
  msrp: number;
  unitPrice: number;
  qty: number;
}

/** Parse the money block that follows an item code, keeping it only when
 *  Wholesale x qty == Amount confirms the split. */
function splitMoneyTail(rest: string): MoneyTail | null {
  const m = MONEY_TAIL.exec(rest);
  if (!m) return null;
  const amount = parseMoney(m[1]);
  const msrp = parseMoney(m[2]);
  const unitPrice = parseMoney(m[3]);
  const qty = Number.parseInt(m[4], 10);
  if (qty > 0 && Math.abs(unitPrice * qty - amount) < 0.01) {
    return { amount, msrp, unitPrice, qty };
  }
  return null;
}

/** Split a run-together item line, using Wholesale x qty == Amount to find the
 *  item-code boundary. Returns null when the line is not an item. */
function tryItem(line: string): BeatrizBallItem | null {
  const firstLetter = line.search(/[A-Za-z]/);
  if (firstLetter <= 0) return null;
  const left = line.slice(0, firstLetter);
  const name = line.slice(firstLetter).trim();
  if (!/^\d/.test(left) || !name) return null;

  for (let codeLen = 1; codeLen < left.length; codeLen++) {
    const money = splitMoneyTail(left.slice(codeLen));
    if (money) {
      return {
        itemCode: left.slice(0, codeLen),
        name,
        qty: money.qty,
        unitPrice: money.unitPrice,
        lineTotal: money.amount,
        msrp: money.msrp,
      };
    }
  }
  return null;
}

/** The first capture group of the first matching line, or undefined. */
function firstCapture(rawLines: readonly string[], pattern: RegExp): string | undefined {
  for (const line of rawLines) {
    const m = pattern.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

/** The first whole line that matches (for fields that ARE the line). */
function firstLine(rawLines: readonly string[], pattern: RegExp): string | undefined {
  return rawLines.find((line) => pattern.test(line));
}

function readHeader(rawLines: readonly string[], order: BeatrizBallOrder): void {
  order.customerPo = firstCapture(rawLines, PO_NUMBER) ?? "";
  order.orderNumber = firstLine(rawLines, ORDER_NUMBER) ?? "";
  order.orderDate = firstLine(rawLines, ORDER_DATE) ?? "";
  const total = firstCapture(rawLines, NET_ORDER);
  if (total !== undefined) order.printedTotal = parseMoney(total);
}

function readItems(rawLines: readonly string[], order: BeatrizBallOrder): void {
  let current: BeatrizBallItem | null = null;
  for (const line of rawLines) {
    if (isBoilerplate(line)) {
      current = null;
      continue;
    }
    const item = tryItem(line);
    if (item) {
      order.items.push(item);
      current = item;
      continue;
    }
    // A plain-text line directly under an item is a wrapped description.
    if (current) {
      current.name = `${current.name} ${line}`.replaceAll(/\s+/g, " ").trim();
    }
  }
}

function reconcile(order: BeatrizBallOrder): void {
  if (order.printedTotal <= 0) return;
  const calculated = order.items.reduce((sum, i) => sum + i.lineTotal, 0);
  if (Math.abs(calculated - order.printedTotal) > 0.01) {
    order.warnings.push(
      `Line totals sum to ${calculated.toFixed(2)}, which does not match the net order ` +
        `${order.printedTotal.toFixed(2)}.`,
    );
  }
}

export function parseBeatrizBallOrderText(text: string): BeatrizBallOrder {
  const order: BeatrizBallOrder = {
    vendorName: "Beatriz Ball",
    orderNumber: "",
    customerPo: "",
    orderDate: "",
    printedTotal: 0,
    items: [],
    warnings: [],
  };

  const rawLines = text
    .split("\n")
    .map((l) => l.replaceAll(/[\u00a0\u2007\u202f]/gu, " ").trim())
    .filter((l) => l !== "");

  readHeader(rawLines, order);
  readItems(rawLines, order);
  reconcile(order);
  return order;
}

export async function parseBeatrizBallOrderPDF(buffer: Buffer): Promise<BeatrizBallOrder> {
  const data = await pdfParse(buffer);
  return parseBeatrizBallOrderText(data.text);
}
