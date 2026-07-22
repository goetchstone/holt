// /app/src/lib/pricing/marketTimeOrderParser.ts
//
// Server-only parser for MarketTime purchase-order PDFs, the format the Harper
// Group rep writes Graf & Lantz orders on ("Purchase Order by MarketTime").
//
// One item is a four-part block:
//
//   6GL70TECH10GN16IN                    <- qty + item number, CONCATENATED
//   Merino Wool 16" Laptop Computer      <- name, 1-2 wrapped lines
//   Sleeve - Granite V (Avail:07/10/26)     with an availability marker
//   84002724051149.00$294.00             <- UPC + unit price + $line total,
//                                           also concatenated
//
// Three things this parser exists to get right, all verified against the real
// order (PON09057, 06/11/2026, 11 SKUs / 73 units / $2,196.00):
//
// 1. Price here is the UNIT price and Total is the extension — the OPPOSITE of
//    Wendover, whose Price column is the line total. Verified on all 11 lines:
//    qty x price == total, and the totals sum to the printed $2,196.00.
//    Getting this backwards would multiply or divide every cost by the qty.
//
// 2. "84002724476284.00$84.00" has NO separator. A greedy digit match reads a
//    13-digit UPC and leaves "4.00" as the price instead of "84.00" — a silent
//    20x cost error that still parses cleanly. So the split is CHECKED against
//    the arithmetic (qty x price == total) rather than trusted, and a block
//    that will not reconcile is reported instead of guessed at.
//
// 3. The document can be a QUOTE, not an order. This one says "Special
//    Instructions: This is just a quote please hold" and "Order still on hold"
//    — importing it would create a PO for something nobody has placed.

const pdfParse = require("pdf-parse");

export interface MarketTimeItem {
  itemNumber: string;
  name: string;
  upc: string;
  qty: number;
  unitPrice: number;
  lineTotal: number;
  /** "(Avail:07/10/26)" — the vendor's availability date, kept out of the
   *  product name but worth showing the buyer. */
  availability: string;
}

export interface MarketTimeOrder {
  vendorName: string;
  poNumber: string;
  orderDate: string;
  shipDate: string;
  printedSubtotal: number;
  printedSkus: number | null;
  printedUnits: number | null;
  /** Text of any hold/quote instruction found. Empty when the document is a
   *  plain order. */
  holdNote: string;
  items: MarketTimeItem[];
  warnings: string[];
}

// The manufacturer prints MID-LINE in a run-together page header
// ("...(cont'd)Cust #MFR: Graf & Lantz IncCustomer: Saybrook Home"), so it is
// read out of the middle rather than anchored, and BEFORE the page-furniture
// filter — which drops that very line.
const MFR = /MFR:\s*(.+?)(?:Cust(?:omer)?\s*#?:?|$)/;
const PO_NUMBER = /^PON\d+$/;
// A MarketTime order that carries no buyer PON prints its own order id instead
// ("Purchase Order by  - ID# 32008813MarketTime" on ACC Art Books). Used only
// as a fallback reference when no PON is found, so a real PON always wins.
const ORDER_ID = /ID#\s*(\d+)/;
// The labels sit on either side of their value depending on the cell's
// alignment: Order Date prints "06/11/2026Order Date:" while Ship Date prints
// "Ship Date:09/22/2026". Both directions, or the field silently reads blank.
const ORDER_DATE = /(?:Order Date:\s*(\d{2}\/\d{2}\/\d{4})|(\d{2}\/\d{2}\/\d{4})\s*Order Date:)/;
const SHIP_DATE = /(?:Ship Date:\s*(\d{2}\/\d{2}\/\d{4})|(\d{2}\/\d{2}\/\d{4})\s*Ship Date:)/;
const SUBTOTAL = /^\$([\d,]+\.\d{2})$/;
const SKUS_UNITS = /^(\d+)\s*Skus\s*\|\s*(\d+)\s*Units/i;
const AVAIL = /\(Avail:([^)]*)\)/i;
const SPECIAL_INSTRUCTIONS = /^Special Instructions:\s*(.+?)\s*$/;
const HOLD_WORDS = /\b(hold|quote)\b/i;
// Fallback vendor source: the MFR line only prints on a continuation page, so a
// single-page order has none. This line is always present ("You will receive an
// invoice from Simon & Schuster").
const INVOICE_FROM = /You will receive an invoice from\s+(.+?)\s*$/;

/** Qty and item number render concatenated ("6GL70TECH10GN16IN"). The item
 *  must start with a LETTER for the boundary to be unambiguous — a numeric
 *  item number would make the split a guess, so it is refused instead. */
const QTY_ITEM = /^(\d{1,4})([A-Za-z][A-Za-z0-9\-/.]*)$/;

// Some vendors (Simon & Schuster books via Anne McGilvray) use the ISBN as the
// item number, so the qty+item line is ALL digits ("12" + a 13-digit ISBN) and
// QTY_ITEM's letter rule can't split it. The ISBN reappears as the UPC on the
// money line, so the split is resolved there: item = that UPC, qty = the digits
// before it. A bare qty like "12" is far shorter, so require a long run.
const NUMERIC_ITEM_HEADER = /^\d{12,}$/;

// A loose "does this line end in money?" test, used only to detect that a line
// starts a new item (the exact split is done by iterating UPC lengths).
const MONEY_TAIL = /\d{11,14}[\d,]+\.\d{2}(?:\d*[A-Za-z]+)?\$[\d,]+\.\d{2}$/;

// UPC + unit price + [optional UQ + UOM] + $line total, all concatenated.
// Graf & Lantz's dialect omits the UQ/UOM columns ("...84.00$84.00"); other
// MarketTime vendors print them ("...7.50" + "1EACH" + "$90.00", or "...19.95"
// + "EA" + "$239.40"), so the middle is an optional run of digits-then-letters
// between the price and the "$". The qty x price == total check below still
// settles where the UPC ends.
const UPC_PRICE_TOTAL = /^(\d{11,14})([\d,]+\.\d{2})(?:\d*[A-Za-z]+)?\$([\d,]+\.\d{2})$/;
const REST_PRICE_TOTAL = /^([\d,]+\.\d{2})(?:\d*[A-Za-z]+)?\$([\d,]+\.\d{2})$/;

function parseMoney(raw: string): number {
  return Number.parseFloat(raw.replaceAll(",", ""));
}

interface PriceParts {
  upc: string;
  unitPrice: number;
  lineTotal: number;
}

/**
 * Split "84002724476284.00$84.00" into its three fields.
 *
 * There is no separator between the UPC and the price, so the split is
 * ambiguous on the face of it: a 13-digit UPC leaves "4.00", a 12-digit one
 * leaves "84.00". The quantity settles it — the only reading that satisfies
 * `qty x price == total` is the right one. Returns null when no reading does,
 * rather than picking the plausible-looking one.
 */
export function splitUpcPriceTotal(line: string, qty: number): PriceParts | null {
  const match = UPC_PRICE_TOTAL.exec(line);
  if (!match) return null;

  const digits = match[1];
  const tail = line.slice(digits.length);
  // Try every UPC length the run of digits allows, shortest first (UPC-A is 12
  // and is what this vendor prints), and keep the one whose money reconciles.
  for (let len = 12; len <= digits.length; len++) {
    const candidate = digits.slice(0, len);
    const rest = digits.slice(len) + tail;
    const parts = REST_PRICE_TOTAL.exec(rest);
    if (!parts) continue;
    const unitPrice = parseMoney(parts[1]);
    const lineTotal = parseMoney(parts[2]);
    if (Math.abs(unitPrice * qty - lineTotal) < 0.01) {
      return { upc: candidate, unitPrice, lineTotal };
    }
  }
  return null;
}

/** The rep's boilerplate, repeated on every page. Dropped before the item
 *  pass so it can never be read as a name or a price. NOTE the header fields
 *  are parsed BEFORE this runs -- the manufacturer rides on one of these very
 *  lines. */
const FURNITURE_PREFIXES = [
  "Purchase Order by",
  "Thank you for your order",
  "QtyImageItem",
] as const;

function isFurniture(line: string): boolean {
  if (FURNITURE_PREFIXES.some((p) => line.startsWith(p))) return true;
  return /^Page\s+of\s+\d+/.test(line) || /^PO #\s*PON\d+\s*\(cont'd\)/.test(line);
}

interface Scan {
  pendingQty: number | null;
  pendingItem: string | null;
  // A numeric qty+ISBN header held until its money line reveals the UPC and
  // lets us split qty from item.
  pendingRaw: string | null;
  nameLines: string[];
}

function flush(scan: Scan, parts: PriceParts, order: MarketTimeOrder): void {
  const rawName = scan.nameLines.join(" ").replaceAll(/\s+/g, " ").trim();
  const availMatch = AVAIL.exec(rawName);
  order.items.push({
    itemNumber: scan.pendingItem as string,
    // The availability marker is order information, not part of the product's
    // name — it would otherwise ship to Ordorite inside every item name.
    name: rawName.replace(AVAIL, "").replaceAll(/\s+/g, " ").trim(),
    upc: parts.upc,
    qty: scan.pendingQty as number,
    unitPrice: parts.unitPrice,
    lineTotal: parts.lineTotal,
    availability: availMatch ? availMatch[1].trim() : "",
  });
  scan.pendingQty = null;
  scan.pendingItem = null;
  scan.pendingRaw = null;
  scan.nameLines = [];
}

function reconcile(order: MarketTimeOrder): void {
  const calculated = order.items.reduce((sum, i) => sum + i.lineTotal, 0);
  if (order.printedSubtotal > 0 && Math.abs(calculated - order.printedSubtotal) > 0.01) {
    order.warnings.push(
      `Line totals sum to ${calculated.toFixed(2)}, which does not match the printed subtotal ` +
        `${order.printedSubtotal.toFixed(2)}.`,
    );
  }
  if (order.printedSkus !== null && order.items.length !== order.printedSkus) {
    order.warnings.push(
      `Read ${order.items.length} item(s), but the document says ${order.printedSkus} SKUs.`,
    );
  }
  const units = order.items.reduce((sum, i) => sum + i.qty, 0);
  if (order.printedUnits !== null && units !== order.printedUnits) {
    order.warnings.push(
      `Quantities total ${units}, but the document says ${order.printedUnits} units.`,
    );
  }
}

/** The first capture the pattern yields on any line, or "". The date patterns
 *  carry TWO alternatives — the label sits on either side of its value
 *  depending on the cell's alignment ("06/11/2026Order Date:" vs "Ship
 *  Date:09/22/2026") — so whichever group matched is the answer. */
function findFirst(rawLines: readonly string[], pattern: RegExp): string {
  for (const line of rawLines) {
    const m = pattern.exec(line);
    const hit = m?.slice(1).find((g) => g?.trim());
    if (hit) return hit.trim();
  }
  return "";
}

/** Order-level fields, read from the UNFILTERED lines: the manufacturer rides
 *  on the repeated page header that the item pass throws away. */
function readHeader(rawLines: readonly string[], order: MarketTimeOrder): void {
  order.vendorName = findFirst(rawLines, MFR) || findFirst(rawLines, INVOICE_FROM);
  order.orderDate = findFirst(rawLines, ORDER_DATE);
  order.shipDate = findFirst(rawLines, SHIP_DATE);
}

/** The totals block + the quote/hold instruction. Returns true when the line
 *  was consumed and the item pass should skip it. */
function readSummaryLine(line: string, order: MarketTimeOrder, subtotals: number[]): boolean {
  if (!order.poNumber && PO_NUMBER.test(line)) {
    order.poNumber = line;
    return true;
  }

  const si = SPECIAL_INSTRUCTIONS.exec(line);
  if (si && HOLD_WORDS.test(si[1])) {
    order.holdNote = si[1];
    return true;
  }
  if (!order.holdNote && /order still on hold/i.test(line)) {
    order.holdNote = line;
    return true;
  }

  const su = SKUS_UNITS.exec(line);
  if (su) {
    order.printedSkus = Number.parseInt(su[1], 10);
    order.printedUnits = Number.parseInt(su[2], 10);
    return true;
  }

  const sub = SUBTOTAL.exec(line);
  if (sub) {
    subtotals.push(parseMoney(sub[1]));
    return true;
  }
  return false;
}

function stripAvail(name: string): { name: string; availability: string } {
  const availMatch = AVAIL.exec(name);
  return {
    name: name.replace(AVAIL, "").replaceAll(/\s+/g, " ").trim(),
    availability: availMatch ? availMatch[1].trim() : "",
  };
}

/** A whole item on ONE concatenated line: qty + itemISBN + name + UPC + price
 *  [+ UQ/UOM] + $total. The item ISBN equals the money UPC (book vendors), so
 *  the prefix must read qty + UPC + name; qty x price == total confirms it.
 *  Returns null when the line is not this shape. */
function tryConcatenatedItem(line: string): MarketTimeItem | null {
  // Try each UPC length; the greedy single match grabs too many digits (a
  // 14-digit UPC leaving a 1-digit-short price), so the qty x price == total
  // check, plus "the prefix reads qty + that same UPC", is what settles it.
  for (let len = 14; len >= 12; len--) {
    const money = new RegExp(
      String.raw`(\d{${len}})([\d,]+\.\d{2})(?:\d*[A-Za-z]+)?\$([\d,]+\.\d{2})$`,
    );
    const m = money.exec(line);
    if (!m || m.index === 0) continue;
    const upc = m[1];
    const unitPrice = parseMoney(m[2]);
    const lineTotal = parseMoney(m[3]);
    const prefix = line.slice(0, m.index);
    const q = new RegExp(String.raw`^(\d+)` + upc).exec(prefix);
    if (!q) continue;
    const qty = Number.parseInt(q[1], 10);
    if (qty <= 0 || Math.abs(unitPrice * qty - lineTotal) > 0.01) continue;
    const { name, availability } = stripAvail(prefix.slice(q[0].length).trim());
    return { itemNumber: upc, name, upc, qty, unitPrice, lineTotal, availability };
  }
  return null;
}

/** Resolve a held numeric header ("12" + ISBN) against its money line: the
 *  money UPC must be a suffix of the header, leaving the qty in front. */
function resolveDeferredNumeric(
  rawHeader: string,
  moneyLine: string,
): { qty: number; item: string; parts: PriceParts } | null {
  // The money line starts with the UPC; the header ends with the same UPC and
  // leaves the qty in front. Try each UPC length and keep the reading where the
  // header splits into an all-digit qty and qty x price == total.
  for (let len = 14; len >= 12; len--) {
    const upc = moneyLine.slice(0, len);
    const rest = REST_PRICE_TOTAL.exec(moneyLine.slice(len));
    if (!rest) continue;
    if (!rawHeader.endsWith(upc)) continue;
    const qtyStr = rawHeader.slice(0, rawHeader.length - len);
    if (!/^\d+$/.test(qtyStr)) continue;
    const qty = Number.parseInt(qtyStr, 10);
    const unitPrice = parseMoney(rest[1]);
    const lineTotal = parseMoney(rest[2]);
    if (qty <= 0 || Math.abs(unitPrice * qty - lineTotal) > 0.01) continue;
    return { qty, item: upc, parts: { upc, unitPrice, lineTotal } };
  }
  return null;
}

/** True when a line begins a NEW item (so it is not more of the current name). */
function isNewItemStart(line: string): boolean {
  return QTY_ITEM.test(line) || NUMERIC_ITEM_HEADER.test(line) || MONEY_TAIL.test(line);
}

/** One line of an item block. The scan is mid-item once a qty+item line has
 *  been seen; the block ends at its money line. */
function readItemLine(line: string, scan: Scan, order: MarketTimeOrder, warnings: string[]): void {
  // Mid-item: the money line closes the block.
  if (scan.pendingItem !== null) {
    const parts = splitUpcPriceTotal(line, scan.pendingQty as number);
    if (parts) {
      flush(scan, parts, order);
      return;
    }
    if (!isNewItemStart(line)) {
      scan.nameLines.push(line);
      return;
    }
    warnings.push(
      `Item ${scan.pendingItem}: no price line was found before the next item -- skipped.`,
    );
    scan.pendingItem = null;
    scan.nameLines = [];
  } else if (scan.pendingRaw !== null) {
    // A held numeric header: its money line reveals qty + item.
    const resolved = resolveDeferredNumeric(scan.pendingRaw, line);
    if (resolved) {
      scan.pendingQty = resolved.qty;
      scan.pendingItem = resolved.item;
      flush(scan, resolved.parts, order);
      return;
    }
    if (!isNewItemStart(line)) {
      scan.nameLines.push(line);
      return;
    }
    warnings.push(
      `Item ${scan.pendingRaw}: no price line was found before the next item -- skipped.`,
    );
    scan.pendingRaw = null;
    scan.nameLines = [];
  }

  // Start a new item. A fully-concatenated single line is complete on its own.
  const whole = tryConcatenatedItem(line);
  if (whole) {
    order.items.push(whole);
    return;
  }
  const qi = QTY_ITEM.exec(line);
  if (qi) {
    scan.pendingQty = Number.parseInt(qi[1], 10);
    scan.pendingItem = qi[2];
    scan.nameLines = [];
    return;
  }
  if (NUMERIC_ITEM_HEADER.test(line)) {
    scan.pendingRaw = line;
    scan.nameLines = [];
  }
}

export function parseMarketTimeOrderText(text: string): MarketTimeOrder {
  const warnings: string[] = [];
  const order: MarketTimeOrder = {
    vendorName: "",
    poNumber: "",
    orderDate: "",
    shipDate: "",
    printedSubtotal: 0,
    printedSkus: null,
    printedUnits: null,
    holdNote: "",
    items: [],
    warnings,
  };

  const rawLines = text
    .split("\n")
    .map((l) => l.replaceAll(/[\u00a0\u2007\u202f]/gu, " ").trim())
    .filter((l) => l !== "");

  readHeader(rawLines, order);

  const scan: Scan = { pendingQty: null, pendingItem: null, pendingRaw: null, nameLines: [] };
  const subtotals: number[] = [];

  for (const line of rawLines) {
    if (isFurniture(line)) continue;
    if (readSummaryLine(line, order, subtotals)) continue;
    readItemLine(line, scan, order, warnings);
  }

  if (scan.pendingItem) {
    warnings.push(`Item ${scan.pendingItem}: no price line was found -- skipped.`);
  }
  if (scan.pendingRaw) {
    warnings.push(`Item ${scan.pendingRaw}: no price line was found -- skipped.`);
  }

  // The totals block prints Sub Total, Promotion Discount and Total; the first
  // is the one the line totals must add up to.
  if (subtotals.length > 0) order.printedSubtotal = subtotals[0];
  // No buyer PON on the document (e.g. ACC Art Books) -- fall back to the
  // MarketTime order id so the PO still carries a reference.
  if (!order.poNumber) order.poNumber = findFirst(rawLines, ORDER_ID);
  reconcile(order);
  return order;
}

export async function parseMarketTimeOrderPDF(buffer: Buffer): Promise<MarketTimeOrder> {
  const data = await pdfParse(buffer);
  return parseMarketTimeOrderText(data.text);
}
